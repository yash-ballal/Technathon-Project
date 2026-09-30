import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function App() {
  const [view, setView] = useState('dashboard');
  const [selectedPatient, setSelectedPatient] = useState(null);
  
  const [patients, setPatients] = useState([]);
  const [cases, setCases] = useState([]);
  const [loadingData, setLoadingData] = useState(false);

  // Case Extraction States
  const [inputText, setInputText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [report, setReport] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);

  // New Patient States
  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientAge, setNewPatientAge] = useState("");
  const [newPatientGender, setNewPatientGender] = useState("Male");
  const [newPatientLocation, setNewPatientLocation] = useState("");
  const [isSubmittingPatient, setIsSubmittingPatient] = useState(false);

  useEffect(() => {
    fetchPatients();
  }, []);

  const fetchPatients = async () => {
    setLoadingData(true);
    const { data, error } = await supabase.from('patients').select('*').order('id', { ascending: true });
    if (!error && data) setPatients(data);
    setLoadingData(false);
  };

  const handleSelectPatient = async (patient) => {
    setSelectedPatient(patient);
    setLoadingData(true);
    setView('patient');

    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .eq('patient_id', patient.id)
      .order('id', { ascending: false });

    if (!error && data) setCases(data);
    setLoadingData(false);
  };

  const handleRegisterPatient = async (e) => {
    e.preventDefault();
    if (!newPatientName || !newPatientAge || !newPatientLocation) return alert("Please fill in all fields.");
    setIsSubmittingPatient(true);

    const newRecord = {
      name: newPatientName,
      age: parseInt(newPatientAge),
      gender: newPatientGender,
      location: newPatientLocation
    };

    const { data, error } = await supabase.from('patients').insert([newRecord]).select();

    if (error) {
      alert("Database error: " + error.message);
    } else if (data) {
      setPatients([...patients, data[0]]);
      setView('dashboard');
      // Reset form
      setNewPatientName("");
      setNewPatientAge("");
      setNewPatientGender("Male");
      setNewPatientLocation("");
    }
    setIsSubmittingPatient(false);
  };

  // --- NEW DELETE PATIENT FUNCTION ---
  const handleDeletePatient = async (patientId) => {
    if (!window.confirm("CRITICAL WARNING: Are you sure you want to delete this patient? This will permanently erase them and ALL their clinical records. This cannot be undone.")) return;
    
    // 1. Delete associated cases first to prevent foreign key constraint errors
    await supabase.from('cases').delete().eq('patient_id', patientId);
    
    // 2. Delete the patient
    const { error } = await supabase.from('patients').delete().eq('id', patientId);
    
    if (error) {
      alert("Error deleting patient: " + error.message);
    } else {
      setPatients((prev) => prev.filter(p => p.id !== patientId));
      setView('dashboard');
    }
  };

  const startVoiceRecording = () => {
    if (!('webkitSpeechRecognition' in window)) return alert("Voice recognition not supported.");
    const recognition = new window.webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-IN';

    recognition.onstart = () => setIsRecording(true);
    recognition.onresult = (event) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + " ";
        }
      }
      if (finalTranscript) setInputText((prev) => prev + finalTranscript);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const extractCase = async () => {
    if (!inputText.trim() && !imageFile) return alert("Please enter notes or upload an image.");
    setLoadingAI(true);

    try {
      const formData = new FormData();
      if (inputText) formData.append("text", inputText);
      if (selectedPatient) formData.append("patient_name", selectedPatient.name);
      if (imageFile) formData.append("image", imageFile);

      const response = await fetch("http://127.0.0.1:8000/api/process-case", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Backend connection failed.");
      }

      const data = await response.json();
      setReport(data.report);
    } catch (error) {
      alert("AI Processing Error: " + error.message);
    }
    setLoadingAI(false);
  };

  const handleApprove = async () => {
    if (!report || !selectedPatient) return;

    const newRecord = {
      patient_id: selectedPatient.id,
      summary: report.summary,
      details: report,
    };

    const { data, error } = await supabase.from('cases').insert([newRecord]).select();

    if (error) {
      alert("Database error: " + error.message);
      return;
    }

    if (data) setCases((prev) => [data[0], ...prev]);

    setReport(null);
    setInputText("");
    setImageFile(null);
    setImagePreview(null);
    setView('patient');
  };

  const deleteCase = async (caseId) => {
    if (!window.confirm("Delete this clinical record permanently?")) return;
    
    const { error } = await supabase.from('cases').delete().eq('id', caseId);
    if (!error) {
      setCases((prev) => prev.filter(c => c.id !== caseId));
    }
  };

  const formatVal = (val) => {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  };

  // --- UI Components ---
  const Header = () => (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('dashboard')}>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shadow-md">
            <span className="text-white font-bold text-lg leading-none tracking-tighter">A</span>
          </div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 tracking-tight">
            AROGYALEKH
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold tracking-wide shadow-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Cloud Sync Active
          </span>
        </div>
      </div>
    </header>
  );

  // --- Views ---
  if (view === 'dashboard') {
    return (
      <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
        <Header />
        <main className="max-w-5xl mx-auto p-6 mt-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-8 gap-4">
            <div>
              <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">Patient Registry</h2>
              <p className="text-slate-500 mt-1">Select a patient to view history or add a new clinical encounter.</p>
            </div>
            <button
              onClick={() => setView('add_patient')}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-semibold shadow-md shadow-blue-200 transition-all flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              Register Patient
            </button>
          </div>
          
          {loadingData ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {patients.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handleSelectPatient(p)}
                  className="group bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:-translate-y-1 hover:border-blue-300 transition-all cursor-pointer flex flex-col justify-between"
                >
                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center font-bold text-lg border border-blue-100">
                        {p.name.charAt(0)}
                      </div>
                      <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-1 rounded-md">ID: {p.id}</span>
                    </div>
                    <h3 className="font-bold text-lg text-slate-800">{p.name}</h3>
                    <p className="text-slate-500 text-sm mt-1 flex items-center gap-2">
                      {p.age} yrs <span className="w-1 h-1 rounded-full bg-slate-300"></span> {p.gender}
                    </p>
                    <p className="text-slate-500 text-sm mt-1">{p.location}</p>
                  </div>
                  <div className="mt-6 flex items-center text-sm font-semibold text-blue-600 group-hover:text-blue-700">
                    Open Record 
                    <svg className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    );
  }

  if (view === 'add_patient') {
    return (
      <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
        <Header />
        <main className="max-w-2xl mx-auto p-6 mt-6">
          <button onClick={() => setView('dashboard')} className="flex items-center text-sm font-medium text-slate-500 hover:text-slate-800 mb-6 transition-colors">
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
            Cancel Registration
          </button>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
            <h2 className="text-2xl font-extrabold tracking-tight mb-6">Register New Patient</h2>
            
            <form onSubmit={handleRegisterPatient} className="space-y-5">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Full Name</label>
                <input 
                  type="text" 
                  value={newPatientName}
                  onChange={(e) => setNewPatientName(e.target.value)}
                  placeholder="e.g. Anil Kumar"
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-slate-700"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Age</label>
                  <input 
                    type="number" 
                    value={newPatientAge}
                    onChange={(e) => setNewPatientAge(e.target.value)}
                    placeholder="e.g. 45"
                    min="0"
                    max="120"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-slate-700"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Gender</label>
                  <select 
                    value={newPatientGender}
                    onChange={(e) => setNewPatientGender(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-slate-700 bg-white"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Location / Village</label>
                <input 
                  type="text" 
                  value={newPatientLocation}
                  onChange={(e) => setNewPatientLocation(e.target.value)}
                  placeholder="e.g. Ward 4, Rural PHC"
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-slate-700"
                  required
                />
              </div>

              <div className="pt-4 mt-2 border-t border-slate-100">
                <button
                  type="submit"
                  disabled={isSubmittingPatient}
                  className="w-full py-3.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-bold text-lg shadow-md transition-all focus:ring-4 focus:ring-slate-200 disabled:opacity-70"
                >
                  {isSubmittingPatient ? "Saving Record..." : "Create Patient Record"}
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    );
  }

  if (view === 'patient') {
    return (
      <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
        <Header />
        <main className="max-w-4xl mx-auto p-6 mt-6">
          <button onClick={() => setView('dashboard')} className="flex items-center text-sm font-medium text-slate-500 hover:text-slate-800 mb-6 transition-colors">
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
            Back to Registry
          </button>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8 mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h2 className="text-3xl font-extrabold tracking-tight">{selectedPatient.name}</h2>
                <span className="px-2.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-semibold border border-slate-200">ID: {selectedPatient.id}</span>
              </div>
              <p className="text-slate-500 text-sm flex items-center gap-2">
                {selectedPatient.age} years old <span className="w-1 h-1 rounded-full bg-slate-300"></span> {selectedPatient.gender} <span className="w-1 h-1 rounded-full bg-slate-300"></span> {selectedPatient.location}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              {/* NEW DELETE BUTTON */}
              <button
                onClick={() => handleDeletePatient(selectedPatient.id)}
                className="bg-white hover:bg-red-50 text-red-600 border border-slate-200 hover:border-red-200 px-5 py-3 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 shadow-sm"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                Delete Profile
              </button>
              <button
                onClick={() => setView('capture')}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold shadow-md shadow-blue-200 transition-all flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                New Encounter
              </button>
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-xl font-bold text-slate-800 border-b border-slate-200 pb-2">Clinical History</h3>
            
            {loadingData ? (
              <p className="text-slate-500 animate-pulse">Loading records...</p>
            ) : cases.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-300">
                <svg className="mx-auto h-12 w-12 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <p className="mt-2 text-sm text-slate-500">No clinical reports found for this patient.</p>
              </div>
            ) : (
              <div className="relative border-l-2 border-slate-200 ml-3 space-y-8 pb-4">
                {cases.map((c) => (
                  <div key={c.id} className="relative pl-8">
                    <div className="absolute w-4 h-4 bg-white border-2 border-blue-500 rounded-full -left-[9px] top-1"></div>
                    <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex justify-between items-start mb-3">
                        <span className="text-sm font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
                          {new Date(c.created_at || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <button onClick={() => deleteCase(c.id)} className="text-slate-400 hover:text-red-500 transition-colors p-1">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                      <p className="text-slate-700 leading-relaxed text-[15px]">{c.summary}</p>
                      
                      <details className="mt-4 group cursor-pointer">
                        <summary className="text-sm font-semibold text-slate-500 hover:text-blue-600 select-none flex items-center outline-none">
                          <span className="group-open:hidden">View Structured Data</span>
                          <span className="hidden group-open:inline">Hide Structured Data</span>
                        </summary>
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-100">
                          {c.details?.confirmed?.map((fact, idx) => (
                            <div key={idx} className="text-sm">
                              <span className="font-semibold text-slate-600 block text-xs uppercase tracking-wider">{fact.field}</span> 
                              <span className="text-slate-900 font-medium">{fact.value}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (view === 'capture') {
    return (
      <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
        <Header />
        <main className="max-w-3xl mx-auto p-6 mt-4">
          <button onClick={() => setView('patient')} className="flex items-center text-sm font-medium text-slate-500 hover:text-slate-800 mb-6 transition-colors">
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            Discard Draft
          </button>

          <div className="mb-6">
            <h2 className="text-2xl font-extrabold tracking-tight">Clinical Encounter</h2>
            <p className="text-slate-500 text-sm mt-1">Recording data for <span className="font-semibold text-slate-700">{selectedPatient.name}</span></p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
            <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <span className="text-sm font-bold text-slate-700 uppercase tracking-wider">Data Ingestion</span>
              <span className="flex h-3 w-3 relative">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isRecording ? 'bg-red-400' : 'bg-transparent'}`}></span>
                <span className={`relative inline-flex rounded-full h-3 w-3 ${isRecording ? 'bg-red-500' : 'bg-slate-300'}`}></span>
              </span>
            </div>
            <div className="p-5">
              <textarea
                className="w-full text-slate-800 text-lg leading-relaxed placeholder-slate-400 bg-transparent border-0 focus:ring-0 resize-none min-h-[120px]"
                placeholder="Dictate observations, type symptoms, or attach clinical notes..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
              />

              {imagePreview && (
                <div className="mt-4 relative w-32 h-32 rounded-xl overflow-hidden border-2 border-slate-200 shadow-sm group">
                  <img src={imagePreview} alt="Attached Note" className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                  <button
                    onClick={() => { setImageFile(null); setImagePreview(null); }}
                    className="absolute top-2 right-2 bg-slate-900/60 backdrop-blur-sm text-white rounded-full w-7 h-7 flex items-center justify-center hover:bg-red-500 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              )}
            </div>
            
            <div className="p-3 bg-slate-50 border-t border-slate-100 flex gap-3 flex-wrap items-center">
              <button
                onClick={startVoiceRecording}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all shadow-sm ${
                  isRecording ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                {isRecording ? (
                  <><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span> Listening...</>
                ) : (
                  <><svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg> Dictate</>
                )}
              </button>

              <label className="flex items-center gap-2 px-4 py-2.5 bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 cursor-pointer rounded-xl text-sm font-bold transition-all shadow-sm">
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                Attach Media
                <input type="file" className="hidden" accept="image/*" onChange={handleImageChange} />
              </label>

              <button
                onClick={extractCase}
                disabled={loadingAI}
                className="ml-auto flex items-center gap-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white disabled:opacity-70 rounded-xl text-sm font-bold shadow-md transition-all"
              >
                {loadingAI ? (
                  <><svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Analyzing...</>
                ) : (
                  <><svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg> Generate Report</>
                )}
              </button>
            </div>
          </div>

          {/* AI Review Panel */}
          {report && (
            <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-200 overflow-hidden animate-fade-in-up">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
                <h3 className="text-lg font-bold text-slate-800">Structured Findings</h3>
              </div>
              
              <div className="p-6 space-y-6">
                <div className="bg-slate-50 p-4 rounded-xl text-slate-700 text-[15px] font-medium leading-relaxed border border-slate-100">
                  {report.summary}
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Confirmed Data
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {Array.isArray(report.confirmed) && report.confirmed.map((item, idx) => (
                      <div key={idx} className="p-3 border border-slate-100 bg-white rounded-xl shadow-sm">
                        <span className="block text-xs font-semibold text-slate-500 mb-1">{formatVal(item.field)}</span>
                        <input
                          type="text"
                          defaultValue={formatVal(item.value)}
                          className="w-full font-medium text-slate-900 bg-transparent border-0 border-b border-dashed border-slate-300 focus:border-blue-500 focus:ring-0 p-0 pb-1"
                        />
                        {item.source_quote && (
                          <p className="text-[11px] text-slate-400 mt-2 font-mono truncate" title={formatVal(item.source_quote)}>
                            "{formatVal(item.source_quote)}"
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {Array.isArray(report.missing) && report.missing.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-rose-500"></span> Missing / Warnings
                    </h4>
                    <div className="space-y-2">
                      {report.missing.map((item, idx) => (
                        <div key={idx} className="flex gap-3 p-3 bg-rose-50 border border-rose-100 rounded-xl">
                          <svg className="w-5 h-5 text-rose-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                          <div>
                            <span className="font-bold text-rose-900 text-sm block">{formatVal(item.field)}</span>
                            <span className="text-rose-700 text-sm">{formatVal(item.reason)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(report.follow_ups) && report.follow_ups.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-500"></span> Follow-up Plan
                    </h4>
                    <ul className="list-inside list-disc space-y-1 text-sm text-slate-700 bg-indigo-50/50 p-4 rounded-xl border border-indigo-100">
                      {report.follow_ups.map((item, idx) => (
                        <li key={idx} className="font-medium">{formatVal(item)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="pt-4 mt-4 border-t border-slate-100">
                  <button
                    onClick={handleApprove}
                    className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-lg shadow-lg shadow-blue-200 hover:shadow-blue-300 transition-all focus:ring-4 focus:ring-blue-100"
                  >
                    Approve & Sign Record
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }
}