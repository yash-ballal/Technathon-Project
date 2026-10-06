import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

function createMockClient() {
  const STORAGE_PREFIX = 'arogyalekh_mock_';

  const defaultData = {
    patients: [
      { id: 1, name: "Ramesh Sharma", age: 45, gender: "Male", location: "Village Rampur, Sector 4", created_at: new Date().toISOString() },
      { id: 2, name: "Sunita Devi", age: 34, gender: "Female", location: "Sub-Center Kalyanpur", created_at: new Date().toISOString() },
      { id: 3, name: "Amit Patel", age: 28, gender: "Male", location: "PHC Shivajinagar, Block B", created_at: new Date().toISOString() }
    ],
    cases: [
      {
        id: 1,
        patient_id: 1,
        summary: "Patient presented with acute fever, cough, and body aches for 3 days. Prescribed Paracetamol and advised rest.",
        details: {
          summary: "Patient presented with acute fever, cough, and body aches for 3 days. Prescribed Paracetamol and advised rest.",
          confirmed: [
            { field: "diagnosis", value: "Viral Pyrexia", source_quote: "fever 3 days" },
            { field: "medication", value: "Tab Paracetamol 500mg TDS", source_quote: "pcm 500" }
          ],
          uncertain: [],
          missing: [
            { field: "blood_pressure", importance: "medium", reason: "Blood pressure vitals not documented" }
          ],
          follow_ups: ["Return if symptoms worsen within 48 hours"]
        },
        created_at: new Date().toISOString()
      }
    ]
  };

  function getTableData(table) {
    if (typeof window === 'undefined') return defaultData[table] || [];
    try {
      const stored = localStorage.getItem(STORAGE_PREFIX + table);
      if (stored) return JSON.parse(stored);
      localStorage.setItem(STORAGE_PREFIX + table, JSON.stringify(defaultData[table] || []));
      return defaultData[table] || [];
    } catch {
      return defaultData[table] || [];
    }
  }

  function saveTableData(table, data) {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_PREFIX + table, JSON.stringify(data));
      } catch (e) {
        console.error("Storage error:", e);
      }
    }
  }

  return {
    isMock: true,
    from(table) {
      const filters = [];
      let sortCol = null;
      let sortAsc = true;
      let action = 'select';
      let insertRecords = null;

      const execute = async () => {
        const rows = [...getTableData(table)];

        if (action === 'insert') {
          const inserted = (insertRecords || []).map((rec, i) => {
            const nextId = rows.length > 0 ? Math.max(...rows.map(r => Number(r.id) || 0)) + 1 + i : 1 + i;
            return { id: nextId, created_at: new Date().toISOString(), ...rec };
          });
          rows.push(...inserted);
          saveTableData(table, rows);
          return { data: inserted, error: null };
        }

        if (action === 'delete') {
          const toDelete = rows.filter(r => filters.every(f => String(r[f.col]) === String(f.val)));
          const remaining = rows.filter(r => !filters.every(f => String(r[f.col]) === String(f.val)));
          saveTableData(table, remaining);
          return { data: toDelete, error: null };
        }

        // select
        const result = rows.filter(r => filters.every(f => String(r[f.col]) === String(f.val)));
        if (sortCol) {
          result.sort((a, b) => {
            if (a[sortCol] < b[sortCol]) return sortAsc ? -1 : 1;
            if (a[sortCol] > b[sortCol]) return sortAsc ? 1 : -1;
            return 0;
          });
        }
        return { data: result, error: null };
      };

      const queryObj = {
        select() {
          return queryObj;
        },
        eq(col, val) {
          filters.push({ col, val });
          return queryObj;
        },
        order(col, options = {}) {
          sortCol = col;
          sortAsc = options.ascending !== false;
          return queryObj;
        },
        insert(records) {
          action = 'insert';
          insertRecords = Array.isArray(records) ? records : [records];
          return queryObj;
        },
        delete() {
          action = 'delete';
          return queryObj;
        },
        then(resolve, reject) {
          return execute().then(resolve, reject);
        }
      };

      return queryObj;
    }
  };
}

let client = null;
if (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('placeholder')) {
  try {
    client = createClient(supabaseUrl, supabaseAnonKey);
  } catch (err) {
    console.warn("Failed to initialize Supabase client, falling back to local mock storage:", err);
  }
}

export const supabase = client || createMockClient();