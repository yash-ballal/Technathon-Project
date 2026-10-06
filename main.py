import os
import json
import base64
from typing import List, Optional, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=api_key) if api_key else None

app = FastAPI(title="AROGYALEKH Backend")

@app.get("/")
def root():
    return {
        "status": "online",
        "service": "AROGYALEKH Backend",
        "openai_configured": bool(client)
    }

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ExtractedFact(BaseModel):
    field: str = Field(description="Clinical field name e.g., 'diagnosis', 'medication', 'eye_vision', 'patient_name'")
    value: Any = Field(description="Extracted value as a string or readable text")
    source_quote: Optional[str] = Field(default="", description="Exact snippet or visual region from input")

class MissingField(BaseModel):
    field: str = Field(description="Expected clinical information omitted")
    importance: str = Field(description="'high', 'medium', or 'low'")
    reason: str = Field(description="Why this is critical")

class CaseReport(BaseModel):
    summary: str
    confirmed: List[ExtractedFact]
    uncertain: List[ExtractedFact]
    missing: List[MissingField]
    follow_ups: List[str]

SYSTEM_PROMPT = """
You are the AI extraction engine for AROGYALEKH, a clinical assistant for frontline healthcare workers.
Convert clinical notes, prescriptions, doctor handwriting images, or transcripts into structured JSON.

CRITICAL SAFETY GUARD (PATIENT MISMATCH):
You will be provided with an "Expected Patient Name". You MUST cross-check this against any name found on the uploaded note or prescription.
If the name on the prescription does NOT match the Expected Patient Name, you MUST flag this immediately in the 'missing' array with field: "Patient Identity Mismatch", importance: "high", and reason: "The name on the document does not match the active patient record. DO NOT proceed with treatment based on this document."

EXTRACTION INSTRUCTIONS:
1. TRANSLATION: If the input contains regional languages (e.g., Hindi, Marathi, Hinglish), you MUST translate the extracted 'value' into standard English medical terminology (e.g., convert "sar dard" to "headache", "fever hai" to "pyrexia").
2. 'summary': Provide a concise 1-2 sentence clinical summary of the patient's visit in standard English.
3. 'confirmed': Add all identifiable medical facts. The 'value' MUST be standardized English medical terms. The 'source_quote' MUST remain in the exact original regional language, Hinglish, or shorthand exactly as it was provided. 
4. 'uncertain': Put anything illegible or ambiguous here.
5. 'missing': Standard clinical details not documented (e.g., blood pressure, systemic history).
6. 'follow_ups': A list of simple string sentences for any explicit follow-up instructions (e.g. ["Review after 3 months"]). DO NOT output JSON objects here.

Output MUST strictly adhere to the JSON schema.
"""

def extract_case_details(text_content: str, base64_image: str = None, mime_type: str = None, expected_name: str = "") -> dict:
    if not client:
        # Fallback response for testing and demonstration when OPENAI_API_KEY is not configured
        clean_name = expected_name.strip() if expected_name else "Patient"
        note_snippet = text_content.strip() if text_content else "Clinical image/prescription uploaded"
        return {
            "summary": f"Clinical consultation summary for {clean_name}. Records: {note_snippet[:80]}.",
            "confirmed": [
                {"field": "diagnosis", "value": "Acute Febrile Illness / Upper Respiratory Infection", "source_quote": note_snippet[:50]},
                {"field": "medication", "value": "Tab Paracetamol 500mg TDS, Tab Cetirizine 10mg OD", "source_quote": "Paracetamol, Cetirizine"},
                {"field": "vitals", "value": "Temperature 101.2°F, Pulse 82 bpm", "source_quote": "fever 101"}
            ],
            "uncertain": [
                {"field": "drug_allergies", "value": "No explicit drug allergy documented (Verify with patient)", "source_quote": "N/A"}
            ],
            "missing": [
                {"field": "blood_pressure", "importance": "medium", "reason": "Baseline blood pressure not recorded"}
            ],
            "follow_ups": [
                "Review after 3 days if fever persists",
                "Ensure proper hydration and oral rehydration salts if weak"
            ]
        }

    user_content = []

    prompt_text = f"Extract and structure all medical information. EXPECTED PATIENT NAME: {expected_name}\n"
    if text_content and text_content.strip():
        prompt_text += f"\nAdditional Worker Notes: {text_content.strip()}"
    
    user_content.append({"type": "text", "text": prompt_text})

    if base64_image:
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime_type};base64,{base64_image}",
                "detail": "high"
            }
        })

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        response_format={"type": "json_object"},
        temperature=0.1
    )
    return json.loads(response.choices[0].message.content)

@app.post("/api/process-case")
async def process_case(
    text: Optional[str] = Form(""),
    patient_name: Optional[str] = Form(""),
    audio: Optional[UploadFile] = File(None),
    image: Optional[UploadFile] = File(None)
):
    final_text = text.strip() if text else ""
    base64_img = None
    img_mime = None

    # Handle Audio
    if audio:
        if not client:
            final_text += " [Audio note transcribed in demo mode: patient reports fever and headache for two days]"
        else:
            try:
                audio_bytes = await audio.read()
                temp_filename = f"temp_{audio.filename}"
                with open(temp_filename, "wb") as f:
                    f.write(audio_bytes)
                
                with open(temp_filename, "rb") as f:
                    transcript_obj = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=f
                    )
                os.remove(temp_filename)
                final_text += " " + transcript_obj.text
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Audio transcription failed: {str(e)}")

    # Handle Image
    if image:
        try:
            image_bytes = await image.read()
            base64_img = base64.b64encode(image_bytes).decode('utf-8')
            img_mime = image.content_type or "image/jpeg"
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Image processing failed: {str(e)}")

    if not final_text and not base64_img:
        raise HTTPException(status_code=400, detail="Provide either text, audio, or an image.")

    structured_data = extract_case_details(final_text, base64_img, img_mime, patient_name)
    
    return {
        "raw_input_text": final_text,
        "has_image": bool(base64_img),
        "report": structured_data
    }