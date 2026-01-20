/* Author House — Production House App (Static GitHub Pages)
   - Projects + chapters
   - DOCX import/export
   - Groq + Perplexity
   - Token-efficient chunking + caching
   - Queue + rate limiting + retries
   - Publishing-house pipeline (Dev, Line, Copy, Market)
   - Local analysis suite
*/

const APP_KEY = "author-house:v1";
const KEY_GROQ = "author-house:groqKey";
const KEY_PPLX = "author-house:pplxKey";
const KEY_MODE = "author-house:mode"; // groq | perplexity | local

const els = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------ 
// Local Model Support
// ------------------------------
const LOCAL_MODELS = [
  { id: 'llama-3.2-1b', name: 'Llama 3.2 1B (Fast)', size: '1B' },
  { id: 'llama-3.2-3b', name: 'Llama 3.2 3B', size: '3B' },
  { id: 'phi-3-mini', name: 'Phi-3 Mini', size: '3.8B' },
  { id: 'gemma-2b', name: 'Gemma 2B', size: '2B' }
];

let localModelInstance = null;

// Check if Web LLM is available
function isLocalModelAvailable() {
  return typeof window.MLCEngine !== 'undefined';
}

// Initialize local model
async function initLocalModel(modelId) {
  if (!isLocalModelAvailable()) {
    throw new Error('Web LLM not loaded. Please include the Web LLM library.');
  }
  
  try {
    setStatus(`Loading ${modelId}...`);
    const engine = new window.MLCEngine();
    await engine.reload(modelId);
    localModelInstance = engine;
    setStatus('Local model ready');
    toast(`${modelId} loaded successfully`);
    return engine;
  } catch (err) {
    log(`Local model init error: ${err}`);
    throw err;
  }
}

// Call local AI model
async function callLocalAI(messages, options = {}) {
  if (!localModelInstance) {
    const selectedModel = localStorage.getItem('author-house:localModel') || 'llama-3.2-1b';
    await initLocalModel(selectedModel);
  }
  
  try {
    const completion = await localModelInstance.chat.completions.create({
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2000
    });
    
    return completion.choices[0].message.content;
  } catch (err) {
    log(`Local AI call error: ${err}`);
    throw err;
  }
}

// Get current AI mode
function getAIMode() {
  return localStorage.getItem(KEY_MODE) || 'groq';
}

// Set AI mode
function setAIMode(mode) {
  localStorage.setItem(KEY_MODE, mode);
  updateModeUI();
}

// Update mode UI indicators
function updateModeUI() {
  const mode = getAIMode();
  document.querySelectorAll('[data-mode]').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
}

/* -----------------------------
   Toast + Status + Logs
--------------------------------*/
function setStatus(text) {
  els("statusPill").textContent = text;
}
function toast(msg) {
  const t = els("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2600);
}
function log(msg) {
  const st = store.get();
  st.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (st.logs.length > 400) st.logs = st.logs.slice(-400);
  store.set(st);
  renderLogs();
}
function renderLogs() {
  els("logBox").textContent = store.get().logs.join("\n");
}

/* -----------------------------
   Storage
--------------------------------*/
const store = {
  get() {
    try {
      const raw = localStorage.getItem(APP_KEY);
      if (!raw) return seedState();
      return JSON.parse(raw);
    } catch {
      return seedState();
    }
  },
  set(st) {
    localStorage.setItem(APP_KEY, JSON.stringify(st));
  }
};

function seedState() {
  const pid = crypto.randomUUID();
  const cid = crypto.randomUUID();
  const st = {
    activeProjectId: pid,
    activeChapterId: cid,
    projects: {
      [pid]: {
        id: pid,
        title: "My Book Project",
        chapters: {
          [cid]: { id: cid, title: "Chapter 1", text: "" }
        },
        chapterOrder: [cid],
        // caches keyed by chunk hash
        cache: {
          summaries: {},    // chapterId -> summary text
          styleGuide: "",   // project-wide
          characterBible: "" // project-wide
        }
      }
    },
    snapshot: "",
    logs: [],
    analysis: null,
    researchOut: "",
    pipelineOut: "",
    settings: {
      groqModel: "llama-3.1-70b-versatile",
      pplxModel: "sonar-pro",
      maxChunkTokens: 1200,
      chunkOutTokens: 700,
      minIntervalMs: 900,
      maxConcurrent: 2,
      pipelineBrief:
        "Run a professional publishing-house pass. Output sections: Developmental Edit, Line Edit, Copy Edit, Market/Positioning. " +
        "Be direct and actionable. Use bullet points. Flag plot holes, pacing, character consistency, clarity, repetition, grammar, formatting. " +
        "Suggest specific fixes. If unsure, say so."
    }
  };
  return st;
}

/* -----------------------------
   Token estimation + chunking
--------------------------------*/
function estimateTokens(text) {
  // Conservative heuristic for English prose
  const chars = (text || "").trim().length;
  if (!chars) return 0;
  return Math.ceil(chars / 3.7);
}

function chunkText(text, { maxTokens, overlapTokens = 120 } = {}) {
  const t = (text || "").replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  const paras = t.split(/\n{2,}/g);

  const chunks = [];
  let buf = "";

  const flush = () => {
    const s = buf.trim();
    if (!s) return;
    chunks.push({ text: s, tokens: estimateTokens(s), hash: hashText(s) });
  };

  for (const p of paras) {
    const next = (buf ? buf + "\n\n" : "") + p;
    if (estimateTokens(next) <= maxTokens) {
      buf = next;
      continue;
    }
    flush();

    // overlap
    const tailChars = Math.min(buf.length, overlapTokens * 4);
    const tail = buf.slice(Math.max(0, buf.length - tailChars)).trim();
    buf = tail ? tail + "\n\n" + p : p;

    // if still too big, hard cut by chars
    while (estimateTokens(buf) > maxTokens) {
      const cut = Math.max(900, Math.floor(buf.length * 0.75));
      const part = buf.slice(0, cut).trim();
      chunks.push({ text: part, tokens: estimateTokens(part), hash: hashText(part) });
      buf = buf.slice(cut).trim();
    }
  }
  flush();
  return chunks;
}

function hashText(s) {
  // quick stable hash (not cryptographic)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/* -----------------------------
   Rate limiter + queue + retries
--------------------------------*/
class RateLimiter {
  constructor({ minIntervalMs = 900, maxConcurrent = 2 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.last = 0;
    this.q = [];
  }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      this.run();
    });
  }
  async run() {
    if (this.active >= this.maxConcurrent) return;
    if (!this.q.length) return;

    const now = Date.now();
    const wait = Math.max(0, this.minIntervalMs - (now - this.last));
    if (wait) {
      setTimeout(() => this.run(), wait);
      return;
    }

    const job = this.q.shift();
    this.active++;
    this.last = Date.now();
    try {
      const out = await job.fn();
      job.resolve(out);
    } catch (e) {
      job.reject(e);
    } finally {
      this.active--;
      this.run();
    }
  }
}

async function withRetries(fn, tries = 2) {
  let lastErr = null;
  for (let i = 0; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(500 + i * 800);
    }
  }
  throw lastErr;
}

/* -----------------------------
   LLM Calls (Groq + Perplexity)
--------------------------------*/
function getGroqKey() { return localStorage.getItem(KEY_GROQ) || ""; }
function getPplxKey() { return localStorage.getItem(KEY_PPLX) || ""; }

async function callGroqChat(messages, maxTokens) {
  const key = getGroqKey();
  if (!key) throw new Error("Missing Groq API key (Settings tab).");

  const st = store.get();
  const model = st.settings.groqModel;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callPerplexityChat(messages) {
  const key = getPplxKey();
  if (!key) throw new Error("Missing Perplexity API key (Settings tab).");

  const st = store.get();
  const model = st.settings.pplxModel;

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model, messages })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Perplexity error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const citations = data?.citations ?? [];
  return citations.length
    ? `${content}\n\nSources:\n${citations.map(c => `- ${c}`).join("\n")}`
    : content;
}

// Unified AI call function that routes to appropriate provider
async function callAI(messages, maxTokens = 2000) {
  const mode = getAIMode();
  
  log(`Calling AI in ${mode} mode...`);
  
  try {
    if (mode === 'local') {
      return await callLocalAI(messages, { max_tokens: maxTokens });
    } else if (mode === 'perplexity') {
      return await callPerplexityChat(messages);
    } else {
      // Default to Groq
      return await callGroqChat(messages, maxTokens);
    }
  } catch (err) {
    log(`AI call failed in ${mode} mode: ${err.message}`);
    throw err;
  }
}

/* -----------------------------
   App Model (Projects/Chapters)
--------------------------------*/
function getActive() {
  const st = store.get();
  const p = st.projects[st.activeProjectId];
  const c = p.chapters[st.activeChapterId];
  return { st, p, c };
}

function setActiveProject(pid) {
  const st = store.get();
  st.activeProjectId = pid;
  const p = st.projects[pid];
  st.activeChapterId = p.chapterOrder[0];
  store.set(st);
  renderAll();
}

function setActiveChapter(cid) {
  const st = store.get();
  st.activeChapterId = cid;
  store.set(st);
  renderAll();
}

function updateChapterTitle(title) {
  const { st, p, c } = getActive();
  c.title = title;
  store.set(st);
  renderProjectUI();
}

function updateChapterText(text) {
  const { st, p, c } = getActive();
  c.text = text;
  store.set(st);
  renderTokenHint();
}

function createProject() {
  const st = store.get();
  const pid = crypto.randomUUID();
  const cid = crypto.randomUUID();
  st.projects[pid] = {
    id: pid,
    title: `Project ${Object.keys(st.projects).length + 1}`,
    chapters: { [cid]: { id: cid, title: "Chapter 1", text: "" } },
    chapterOrder: [cid],
    cache: { summaries: {}, styleGuide: "", characterBible: "" }
  };
  st.activeProjectId = pid;
  st.activeChapterId = cid;
  store.set(st);
  renderAll();
  toast("Project created");
}

function deleteProject() {
  const st = store.get();
  const ids = Object.keys(st.projects);
  if (ids.length <= 1) return toast("Keep at least 1 project.");
  delete st.projects[st.activeProjectId];
  const next = Object.keys(st.projects)[0];
  st.activeProjectId = next;
  st.activeChapterId = st.projects[next].chapterOrder[0];
  store.set(st);
  renderAll();
  toast("Project deleted");
}

function renameProject() {
  const st = store.get();
  const p = st.projects[st.activeProjectId];
  const name = prompt("New project name:", p.title);
  if (!name) return;
  p.title = name.trim();
  store.set(st);
  renderProjectUI();
}

function createChapter() {
  const { st, p } = getActive();
  const cid = crypto.randomUUID();
  p.chapters[cid] = { id: cid, title: `Chapter ${p.chapterOrder.length + 1}`, text: "" };
  p.chapterOrder.push(cid);
  st.activeChapterId = cid;
  store.set(st);
  renderAll();
  toast("Chapter added");
}

function autoSplitChapters() {
  const { st, p } = getActive();
  const full = p.chapterOrder.map(id => p.chapters[id].text).join("\n\n");
  const raw = full.replace(/\r\n/g, "\n").trim();
  if (!raw) return toast("Nothing to split.");

  const markers = raw.split(/\n(?=(?:chapter|part)\s+\d+[:\s]|^#{1,6}\s+)/gmi);
  if (markers.length < 2) return toast("Couldn’t detect chapters. Use “Add” instead.");

  p.chapters = {};
  p.chapterOrder = [];
  markers.forEach((block, i) => {
    const cid = crypto.randomUUID();
    const firstLine = (block.trim().split("\n")[0] || "").trim();
    const title = firstLine.length <= 80 ? firstLine.replace(/^#+\s*/, "") : `Chapter ${i + 1}`;
    p.chapters[cid] = { id: cid, title, text: block.trim() };
    p.chapterOrder.push(cid);
  });

  st.activeChapterId = p.chapterOrder[0];
  store.set(st);
  renderAll();
  toast(`Split into ${markers.length} chapters`);
}

/* -----------------------------
   DOCX Import/Export
--------------------------------*/
async function importDocx() {
  const f = els("docxInput").files?.[0];
  if (!f) return toast("Choose a .docx file first.");
  setStatus("Importing…");
  log("DOCX import started");
  try {
    const arrayBuffer = await f.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = (result.value || "").trim();

    // Put into current chapter
    const { st, c } = getActive();
    c.text = text;
    store.set(st);
    renderAll();
    toast("Imported DOCX into current chapter");
    log("DOCX import complete");
  } catch (e) {
    log(`DOCX import error: ${String(e?.message || e)}`);
    toast("DOCX import failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

async function exportDocx() {
  setStatus("Exporting…");
  log("DOCX export started");
  try {
    const { st, p } = getActive();
    const docx = window.docx;

    const children = [];
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: p.title, bold: true, size: 42 })]
    }));
    children.push(new docx.Paragraph(""));

    for (const cid of p.chapterOrder) {
      const ch = p.chapters[cid];
      children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: ch.title, bold: true, size: 32 })] }));
      children.push(new docx.Paragraph(""));

      const lines = (ch.text || "").replace(/\r\n/g, "\n").split("\n");
      for (const line of lines) children.push(new docx.Paragraph(line));
      children.push(new docx.Paragraph(""));
    }

    const d = new docx.Document({ sections: [{ children }] });
    const blob = await docx.Packer.toBlob(d);
    downloadBlob(blob, `${safeFile(p.title)}.docx`);
    toast("Exported DOCX");
    log("DOCX export complete");
  } catch (e) {
    log(`DOCX export error: ${String(e?.message || e)}`);
    toast("DOCX export failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

function safeFile(name) {
  return (name || "Manuscript").replace(/[^\w\- ]+/g, "").trim() || "Manuscript";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* -----------------------------
   Editor helpers
--------------------------------*/
function getSelectionInEditor() {
  // For textarea, browser selectionStart/End
  const ta = els("editor");
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  if (end <= start) return "";
  return ta.value.slice(start, end);
}

function replaceSelectionWith(text) {
  const ta = els("editor");
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  ta.value = before + text + after;
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.dispatchEvent(new Event("input"));
}

function insertBelowCursor(text) {
  const ta = els("editor");
  const pos = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const insert = (before.endsWith("\n") ? "" : "\n") + "\n" + text + "\n";
  ta.value = before + insert + after;
  ta.selectionStart = ta.selectionEnd = (before + insert).length;
  ta.dispatchEvent(new Event("input"));
}

/* -----------------------------
   Quick AI Actions (token-light)
--------------------------------*/
const limiter = () => {
  const st = store.get();
  return new RateLimiter({ minIntervalMs: st.settings.minIntervalMs, maxConcurrent: st.settings.maxConcurrent });
};
let rate = limiter();

async function quickLineEdit() {
  const sel = getSelectionInEditor();
  const { c } = getActive();
  const input = sel.trim() ? sel : (c.text || "");
  if (!input.trim()) return toast("Nothing to edit.");

  // Token-light: cap size
  const clipped = clipByTokens(input, 1200);

  setStatus("AI…");
  log("Quick line edit started");
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callGroqChat([
        { role: "system", content: "You are a world-class line editor. Be concise, professional, and improve clarity and rhythm." },
        { role: "user", content: `Line edit this. Keep meaning. Return only improved text.\n\n${clipped}` }
      ], 800)
    ), 2);
    els("aiOut").textContent = out;
    toast("AI output ready");
  } catch (e) {
    log(`Quick line edit error: ${String(e?.message || e)}`);
    toast("AI edit failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

async function quickContinue() {
  const { c } = getActive();
  const t = (c.text || "");
  if (!t.trim()) return toast("Write something first.");

  // last ~900 words / token-light window
  const windowText = tailWords(t, 900);

  setStatus("AI…");
  log("Continue writing started");
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callGroqChat([
        { role: "system", content: "You are a bestselling novelist. Continue in the same voice, pacing, tense, and POV. Avoid clichés." },
        { role: "user", content: `Continue from here. Keep it coherent and compelling.\n\n${windowText}` }
      ], 700)
    ), 2);
    els("aiOut").textContent = out;
    toast("AI continuation ready");
  } catch (e) {
    log(`Continue writing error: ${String(e?.message || e)}`);
    toast("AI continue failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

async function quickSummaryFacts() {
  const { st, p, c } = getActive();
  const text = (c.text || "");
  if (!text.trim()) return toast("Chapter is empty.");

  setStatus("AI…");
  log("Chapter summary started");
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callGroqChat([
        { role: "system", content: "You produce structured summaries and track facts for continuity." },
        { role: "user", content:
          "Summarize this chapter in 8 bullets. Then list key facts (names, dates, locations, promises, injuries, items) as a fact table.\n\n" +
          clipByTokens(text, 1200)
        }
      ], 700)
    ), 2);

    // cache
    p.cache.summaries[c.id] = out;
    store.set(st);

    els("aiOut").textContent = out;
    toast("Summary + facts ready");
  } catch (e) {
    log(`Summary error: ${String(e?.message || e)}`);
    toast("Summary failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

function clipByTokens(text, maxTokens) {
  const t = (text || "").trim();
  if (!t) return "";
  if (estimateTokens(t) <= maxTokens) return t;
  const ratio = maxTokens / estimateTokens(t);
  const targetChars = Math.max(1000, Math.floor(t.length * ratio));
  return t.slice(0, targetChars);
}

function tailWords(text, n) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const slice = words.slice(Math.max(0, words.length - n));
  return slice.join(" ");
}

/* -----------------------------
   Local Analysis Suite
--------------------------------*/
function runAnalysis() {
  const { c } = getActive();
  const t = (c.text || "").trim();
  if (!t) return toast("Chapter is empty.");

  const words = t.split(/\s+/).length;
  const sentences = t.split(/[.!?]+/).filter(Boolean).length || 1;
  const paragraphs = t.split(/\n{2,}/).filter(Boolean).length;

  const quoteCount = (t.match(/"/g) || []).length;
  const dialogueBlocks = Math.floor(quoteCount / 2);

  const avgSentenceLen = words / sentences;

  const syllables = (t.match(/[aeiouyAEIOUY]{1,2}/g) || []).length || 1;
  const readingEase = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);

  const repeated = topRepeated(t, 18);

  const report = {
    words,
    sentences,
    paragraphs,
    dialogueBlocks,
    avgSentenceLen: round(avgSentenceLen, 2),
    readingEase: round(readingEase, 2),
    tokenEstimate: estimateTokens(t),
    topRepeatedWords: repeated,
    notes: [
      "Reading Ease is a heuristic; best used comparatively across drafts.",
      "DialogueBlocks uses quote marks; if you use different punctuation, it will undercount."
    ]
  };

  els("analysisOut").textContent = JSON.stringify(report, null, 2);
  toast("Analysis ready");
}

function topRepeated(text, n) {
  const stop = new Set(["the","and","a","an","to","of","in","it","is","was","i","you","he","she","they","we","that","this","for","on","with","as","at","by","from","or","but","not","be","are","have","had"]);
  const tokens = (text.toLowerCase().match(/[a-z']{2,}/g) || []).filter(w => !stop.has(w));
  const map = new Map();
  for (const w of tokens) map.set(w, (map.get(w) || 0) + 1);
  return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([word,count])=>({word,count}));
}
function round(x, d) {
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

/* -----------------------------
   Consistency: Style Guide + Character Bible (project-wide)
--------------------------------*/
async function buildStyleGuide() {
  const { st, p } = getActive();
  const projectText = getProjectText(p);
  if (!projectText.trim()) return toast("Project is empty.");

  setStatus("AI…");
  log("Building style guide started");
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callGroqChat([
        { role: "system", content: "You extract a writing style guide for consistency (voice, tense, POV, formatting, conventions)." },
        { role: "user", content:
          "Create a compact style guide for this book. Include: POV/tense, tone, language level, dialogue style, formatting conventions, " +
          "spelling (UK/US), character voice notes, recurring motifs, banned words, preferred phrasing. Be concise.\n\n" +
          clipByTokens(projectText, 1600)
        }
      ], 800)
    ), 2);
    p.cache.styleGuide = out;
    store.set(st);
    els("consistencyOut").textContent = out;
    toast("Style guide ready");
  } catch (e) {
    log(`Style guide error: ${String(e?.message || e)}`);
    toast("Style guide failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

async function buildCharacterBible() {
  const { st, p } = getActive();
  const projectText = getProjectText(p);
  if (!projectText.trim()) return toast("Project is empty.");

  setStatus("AI…");
  log("Building character bible started");
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callGroqChat([
        { role: "system", content: "You build a structured character bible for continuity and future writing." },
        { role: "user", content:
          "Build a character bible in JSON with fields per character: name, age, appearance, voice, goals, conflicts, relationships, secrets, " +
          "timeline facts. If unknown, use null. Include locations and key items too.\n\n" +
          clipByTokens(projectText, 1600)
        }
      ], 900)
    ), 2);
    p.cache.characterBible = out;
    store.set(st);
    els("consistencyOut").textContent = out;
    toast("Character bible ready");
  } catch (e) {
    log(`Character bible error: ${String(e?.message || e)}`);
    toast("Character bible failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

function getProjectText(p) {
  return p.chapterOrder.map(cid => `# ${p.chapters[cid].title}\n\n${p.chapters[cid].text || ""}`).join("\n\n");
}

/* -----------------------------
   Publishing House Pipeline (full system, chunked, cached, rate-limited)
--------------------------------*/
async function runPipeline() {
  const { st, p, c } = getActive();
  const scope = els("pipelineScope").value;

  const text = scope === "project" ? getProjectText(p) : (c.text || "");
  if (!text.trim()) return toast("Nothing to run pipeline on.");

  const brief = (els("pipelineBrief").value || "").trim();
  st.settings.pipelineBrief = brief;
  store.set(st);

  setStatus("Pipeline…");
  log(`Pipeline started (${scope})`);

  try {
    const chunks = chunkText(text, { maxTokens: st.settings.maxChunkTokens, overlapTokens: 120 });
    if (!chunks.length) return toast("No chunks produced.");

    const roles = [
      { name: "Developmental Editor", task: "Plot, pacing, structure, stakes, character arcs, logic gaps." },
      { name: "Line Editor", task: "Clarity, flow, voice, repetition, imagery, dialogue quality." },
      { name: "Copy Editor", task: "Grammar, punctuation, spelling, continuity, formatting issues." },
      { name: "Market Editor", task: "Hook strength, genre fit, positioning, blurb angles, comp titles." }
    ];

    const cache = p.cache.pipelineCache || (p.cache.pipelineCache = {});
    const reportSections = [];

    for (const role of roles) {
      reportSections.push(`\n=== ${role.name} ===\n`);
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const key = `${role.name}:${ch.hash}:${hashText(brief)}`;

        if (cache[key]) {
          log(`${role.name} chunk ${i+1}/${chunks.length} (cached)`);
          reportSections.push(cache[key]);
          continue;
        }

        log(`${role.name} chunk ${i+1}/${chunks.length}`);
        const prompt =
          `${brief}\n\nROLE: ${role.name}\nROLE TASK: ${role.task}\n\n` +
          "Return bullet points only. Be specific: quote short fragments when helpful. No fluff.\n\n" +
          `TEXT CHUNK:\n${ch.text}`;

        const out = await withRetries(() => rate.schedule(() =>
          callGroqChat([{ role: "user", content: prompt }], st.settings.chunkOutTokens)
        ), 2);

        const section = `\n[Chunk ${i+1}/${chunks.length}]\n${out}\n`;
        cache[key] = section;
        reportSections.push(section);

        // persist incremental progress so you don't lose work
        store.set(st);
        els("pipelineOut").textContent = reportSections.join("\n");
      }
    }

    els("pipelineOut").textContent = reportSections.join("\n");
    toast("Pipeline complete");
    log("Pipeline complete");
  } catch (e) {
    log(`Pipeline error: ${String(e?.message || e)}`);
    toast("Pipeline failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

function downloadPipeline() {
  const content = els("pipelineOut").textContent || "";
  if (!content.trim()) return toast("No pipeline report yet.");
  downloadBlob(new Blob([content], { type: "text/plain" }), "pipeline_report.txt");
}

/* -----------------------------
   Research (Perplexity)
--------------------------------*/
async function askResearch() {
  const q = (els("researchQuery").value || "").trim();
  if (!q) return toast("Type a research question.");

  setStatus("Research…");
  log(`Research: ${q}`);
  try {
    const out = await withRetries(() => rate.schedule(() =>
      callPerplexityChat([{ role: "user", content: q }])
    ), 1);
    els("researchOut").textContent = out;
    toast("Research ready");
  } catch (e) {
    log(`Research error: ${String(e?.message || e)}`);
    toast("Research failed (see logs).");
  } finally {

     /* -----------------------------
   AI Book Planner (Chat & Generate)
--------------------------------*/
let plannerChat = [];

async function sendPlannerMessage() {
  const input = els("plannerInput").value.trim();
  if (!input) return toast("Type a message.");
  
  // Add user message to chat
  plannerChat.push({ role: "user", content: input });
  renderPlannerChat();
  els("plannerInput").value = "";
  
  setStatus("AI thinking...");
  log(`Book Planner: User asked: ${input}`);
  
  try {
    const systemPrompt = {
      role: "system",
      content: "You are an expert book planning assistant. Help the author develop their book idea by asking questions about genre, plot, characters, target word count, and chapter structure. Be conversational and helpful. When the author confirms they're ready, provide a complete book plan with: title, genre, target word count, number of chapters, chapter titles, plot outline, character descriptions, and writing style notes."
    };
    
    const out = await withRetries(() => rate.schedule(() =>
      callAI([systemPrompt, ...plannerChat], 1500)
    ), 2);
    
    // Add AI response to chat
    plannerChat.push({ role: "assistant", content: out });
    renderPlannerChat();
    toast("AI responded");
    log("Book Planner: AI responded");
  } catch (e) {
    log(`Book Planner error: ${String(e?.message || e)}`);
    toast("AI failed (see logs).");
  } finally {
    setStatus("Ready");
  }
}

function renderPlannerChat() {
  const box = els("plannerChatBox");
  box.innerHTML = "";
  
  plannerChat.forEach(msg => {
    const div = document.createElement("div");
    div.className = msg.role === "user" ? "chat-user" : "chat-ai";
    div.textContent = `${msg.role === "user" ? "You" : "AI"}: ${msg.content}`;
    box.appendChild(div);
  });
  
  // Scroll to bottom
  box.scrollTop = box.scrollHeight;
}

function clearPlannerChat() {
  plannerChat = [];
  renderPlannerChat();
  toast("Chat cleared");
}

async function generateBookFromPlan() {
  if (plannerChat.length === 0) return toast("Chat with AI first to develop a plan.");
  
  setStatus("Extracting book plan...");
  log("Generating book from planner chat...");
  
  try {
    // Ask AI to extract structured plan from chat
    const extractPrompt = {
      role: "system",
      content: "Extract a structured book plan from the conversation. Return JSON with: {title, genre, targetWordCount, numChapters, chapterTitles: [], plotOutline, characterDescriptions, styleNotes}. If info is missing, use reasonable defaults."
    };
    
    const planJSON = await withRetries(() => rate.schedule(() =>
      callAI([extractPrompt, ...plannerChat, { role: "user", content: "Extract the book plan as JSON now." }], 2000)
    ), 2);
    
    let plan;
    try {
      // Try to parse JSON from AI response
      const jsonMatch = planJSON.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : planJSON);
    } catch (e) {
      log("Failed to parse plan JSON, using defaults");
      plan = {
        title: "Untitled Book",
        genre: "Fiction",
        targetWordCount: 60000,
        numChapters: 20,
        chapterTitles: Array.from({length: 20}, (_, i) => `Chapter ${i+1}`),
        plotOutline: "To be developed",
        characterDescriptions: "To be developed",
        styleNotes: "Engaging narrative style"
      };
    }
    
    // Create new project
    const st = store.get();
    const pid = crypto.randomUUID();
    const chapters = {};
    const chapterOrder = [];
    
    // Create chapters
    const wordsPerChapter = Math.floor(plan.targetWordCount / plan.numChapters);
    for (let i = 0; i < plan.numChapters; i++) {
      const cid = crypto.randomUUID();
      chapters[cid] = {
        id: cid,
        title: plan.chapterTitles[i] || `Chapter ${i+1}`,
        text: "" // Will be written by AI
      };
      chapterOrder.push(cid);
    }
    
    // Create project with metadata
    st.projects[pid] = {
      id: pid,
      title: plan.title,
      chapters,
      chapterOrder,
      cache: {
        summaries: {},
        styleGuide: plan.styleNotes || "",
        characterBible: plan.characterDescriptions || "",
        plotOutline: plan.plotOutline || ""
      },
      bookPlan: plan // Store the full plan
    };
    
    st.activeProjectId = pid;
    st.activeChapterId = chapterOrder[0];
    store.set(st);
    renderAll();
    
    toast(`Project "${plan.title}" created with ${plan.numChapters} chapters!`);
    log(`Book project created: ${plan.title}`);
    
    // Ask if user wants to auto-write the book
    if (confirm(`Project created! Write all chapters now using AI? (This will take several minutes)`)) {
      await writeEntireBook(pid);
    }
    
  } catch (e) {
    log(`Generate book error: ${String(e?.message || e)}`);
    toast("Failed to generate book (see logs).");
  } finally {
    setStatus("Ready");
  }
}

async function writeEntireBook(projectId) {
  const st = store.get();
  const p = st.projects[projectId];
  const plan = p.bookPlan;
  
  if (!plan) return toast("No book plan found.");
  
  setStatus("Writing book...");
  log(`Starting full book write for: ${p.title}`);
  
  const wordsPerChapter = Math.floor(plan.targetWordCount / plan.numChapters);
  let previousChapterSummary = "";
  
  for (let i = 0; i < p.chapterOrder.length; i++) {
    const cid = p.chapterOrder[i];
    const chapter = p.chapters[cid];
    
    log(`Writing ${chapter.title} (${i+1}/${p.chapterOrder.length})...`);
    setStatus(`Writing ${chapter.title}...`);
    
    try {
      const chapterPrompt = [
        {
          role: "system",
          content: `You are writing chapter ${i+1} of "${p.title}". Genre: ${plan.genre}. Target: ~${wordsPerChapter} words.\n\nPlot: ${plan.plotOutline}\nCharacters: ${plan.characterDescriptions}\nStyle: ${plan.styleNotes}\n\nWrite engaging, well-structured prose. Use proper paragraphing and dialogue.`
        },
        {
          role: "user",
          content: `Write chapter ${i+1}: "${chapter.title}".${previousChapterSummary ? `\n\nPrevious chapter summary: ${previousChapterSummary}` : ""}\n\nWrite approximately ${wordsPerChapter} words.`
        }
      ];
      
      const chapterText = await withRetries(() => rate.schedule(() =>
        callAI(chapterPrompt, Math.min(4000, wordsPerChapter * 2))
      ), 2);
      
      chapter.text = chapterText;
      store.set(st);
      
      // Generate summary for next chapter context
      if (i < p.chapterOrder.length - 1) {
        const summaryPrompt = [
          { role: "system", content: "Summarize this chapter in 3-4 sentences for continuity." },
          { role: "user", content: chapterText.slice(0, 2000) }
        ];
        previousChapterSummary = await withRetries(() => rate.schedule(() =>
          callAI(summaryPrompt, 300)
        ), 1);
      }
      
      log(`Completed ${chapter.title}`);
      
    } catch (e) {
      log(`Error writing ${chapter.title}: ${String(e?.message || e)}`);
      chapter.text = `[Error writing this chapter. Please write manually or retry.]`;
      store.set(st);
    }
    
    // Update UI
    if (i === 0) renderAll();
  }
  
  toast(`Book "${p.title}" complete!`);
  log(`Full book write complete: ${p.title}`);
  setStatus("Ready");
  renderAll();
}
    setStatus("Ready");
  }
}

/* -----------------------------
   Snapshot / Apply AI Output
--------------------------------*/
function snapshot() {
  const st = store.get();
  st.snapshot = els("editor").value || "";
  store.set(st);
  toast("Snapshot saved");
}
function restoreSnapshot() {
  const st = store.get();
  if (!st.snapshot) return toast("No snapshot saved.");
  els("editor").value = st.snapshot;
  els("editor").dispatchEvent(new Event("input"));
  toast("Snapshot restored");
}
function clearAiOutput() {
  els("aiOut").textContent = "";
  toast("AI output cleared");
}
function applyAiInsert() {
  const out = (els("aiOut").textContent || "").trim();
  if (!out) return toast("No AI output to apply.");
  insertBelowCursor(out);
  toast("Inserted below cursor");
}
function applyAiReplaceSelection() {
  const out = (els("aiOut").textContent || "").trim();
  if (!out) return toast("No AI output to apply.");
  const sel = getSelectionInEditor();
  if (!sel) return toast("Select text first (or use Insert).");
  replaceSelectionWith(out);
  toast("Selection replaced");
}

/* -----------------------------
   Settings
--------------------------------*/
function saveKeys() {
  localStorage.setItem(KEY_GROQ, els("groqKey").value.trim());
  localStorage.setItem(KEY_PPLX, els("pplxKey").value.trim());
  toast("Keys saved in this browser");
}
function forgetKeys() {
  localStorage.removeItem(KEY_GROQ);
  localStorage.removeItem(KEY_PPLX);
  els("groqKey").value = "";
  els("pplxKey").value = "";
  toast("Keys forgotten");
}
function savePerf() {
  const st = store.get();
  st.settings.maxChunkTokens = Number(els("maxChunkTokens").value || 1200);
  st.settings.minIntervalMs = Number(els("minIntervalMs").value || 900);
  st.settings.maxConcurrent = Number(els("maxConcurrent").value || 2);
  st.settings.chunkOutTokens = Number(els("chunkOutTokens").value || 700);
  st.settings.groqModel = (els("groqModel").value || st.settings.groqModel).trim();
  st.settings.pplxModel = (els("pplxModel").value || st.settings.pplxModel).trim();
  store.set(st);
  rate = limiter(); // rebuild limiter with new values
  toast("Optimization settings saved");
}

function exportLogs() {
  const content = store.get().logs.join("\n");
  downloadBlob(new Blob([content], { type: "text/plain" }), "author_house_logs.txt");
}

/* -----------------------------
   UI rendering
--------------------------------*/
function renderProjectUI() {
  const { st, p, c } = getActive();

  // projects dropdown
  const ps = els("projectSelect");
  ps.innerHTML = "";
  for (const pid of Object.keys(st.projects)) {
    const opt = document.createElement("option");
    opt.value = pid;
    opt.textContent = st.projects[pid].title;
    ps.appendChild(opt);
  }
  ps.value = st.activeProjectId;

  // chapters dropdown
  const cs = els("chapterSelect");
  cs.innerHTML = "";
  for (const cid of p.chapterOrder) {
    const opt = document.createElement("option");
    opt.value = cid;
    opt.textContent = p.chapters[cid].title;
    cs.appendChild(opt);
  }
  cs.value = st.activeChapterId;

  // editor + title
  els("chapterTitle").value = c.title;
  els("editor").value = c.text;

  // pipeline brief
  els("pipelineBrief").value = st.settings.pipelineBrief;

  renderTokenHint();
}

function renderTokenHint() {
  const text = els("editor").value || "";
  els("tokenHint").textContent = `Tokens: ${estimateTokens(text)}`;
}

function renderSettings() {
  const st = store.get();
  els("groqKey").value = getGroqKey();
  els("pplxKey").value = getPplxKey();

  els("groqModel").value = st.settings.groqModel;
  els("pplxModel").value = st.settings.pplxModel;

  els("maxChunkTokens").value = st.settings.maxChunkTokens;
  els("minIntervalMs").value = st.settings.minIntervalMs;
  els("maxConcurrent").value = st.settings.maxConcurrent;
  els("chunkOutTokens").value = st.settings.chunkOutTokens;
}

function renderAll() {
  renderProjectUI();
  renderSettings();
  renderLogs();
}
// Force redeploy

/* -----------------------------
   Tabs
--------------------------------*/
}function initTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            const tab = btn.getAttribute("data-tab");
            document.querySelectorAll(".tabPane").forEach(p => p.classList.add("hidden"));
            const targetPane = document.getElementById(`tab-${tab}`);
            if (targetPane) targetPane.classList.remove("hidden");
        });
    });
}
/* -----------------------------
   Wire up events
--------------------------------*/
function init() {
  initTabs();

  // sidebar
  els("btnNewProject").onclick = () => { createProject(); };
  els("projectSelect").onchange = (e) => setActiveProject(e.target.value);
  els("btnRenameProject").onclick = renameProject;
  els("btnDeleteProject").onclick = deleteProject;

  els("btnAutoChapters").onclick = autoSplitChapters;
  els("btnNewChapter").onclick = createChapter;
  els("chapterSelect").onchange = (e) => setActiveChapter(e.target.value);

  els("btnImportDocx").onclick = importDocx;
  els("btnExportDocx").onclick = exportDocx;

  els("btnQuickEdit").onclick = quickLineEdit;
  els("btnQuickContinue").onclick = quickContinue;
  els("btnQuickSummary").onclick = quickSummaryFacts;

  // write tab
  els("chapterTitle").oninput = (e) => updateChapterTitle(e.target.value);
  els("editor").oninput = (e) => updateChapterText(e.target.value);
  els("btnSelectAll").onclick = () => { const ta = els("editor"); ta.focus(); ta.select(); };
  els("btnSnapshot").onclick = snapshot;
  els("btnUndoSnapshot").onclick = restoreSnapshot;

  els("btnApplyAi").onclick = applyAiInsert;
  els("btnReplaceSelection").onclick = applyAiReplaceSelection;
  els("btnClearAi").onclick = clearAiOutput;

  // analysis tab
  els("btnRunAnalysis").onclick = runAnalysis;
  els("btnBuildStyleGuide").onclick = buildStyleGuide;
  els("btnCharacterBible").onclick = buildCharacterBible;

  // pipeline tab
  els("btnRunPipeline").onclick = runPipeline;
  els("btnDownloadPipeline").onclick = downloadPipeline;

  // research tab
  els("btnAskResearch").onclick = askResearch;

  // settings tab
  els("btnSaveKeys").onclick = saveKeys;
  els("btnForgetKeys").onclick = forgetKeys;
  els("btnSavePerf").onclick = savePerf;

  // logs
  els("btnClearLogs").onclick = () => { const st = store.get(); st.logs = []; store.set(st); renderLogs(); };
  els("btnExportLogs").onclick = exportLogs;

  // local model copy helpers
  els("btnCopyOllama1").onclick = async () => { await navigator.clipboard.writeText("ollama pull llama3.1"); toast("Copied"); };
  els("btnCopyOllama2").onclick = async () => { await navigator.clipboard.writeText("ollama pull mistral"); toast("Copied"); };
  els("btnCopyOllama3").onclick = async () => { await navigator.clipboard.writeText("ollama pull qwen2.5"); toast("Copied"); };

  // initialize
  renderAll();
  setStatus("Ready");
  log("App loaded");
}

/* -----------------------------
   Tabs
--------------------------------*/
function initTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            const tab = btn.getAttribute("data-tab");
            document.querySelectorAll(".tabPane").forEach(p => p.classList.add("hidden"));
            const targetPane = document.getElementById(`tab-${tab}`);
            if (targetPane) targetPane.classList.remove("hidden");
        });
    });
}

/* -----------------------------
   Wire up events
--------------------------------*/
function init() {
    initTabs();
    
    // Book Planner event handlers
    els("btnSendPlanner").addEventListener("click", sendPlannerMessage);
    els("plannerInput").addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendPlannerMessage();
    });
    els("btnClearPlanner").addEventListener("click", clearPlannerChat);
    els("btnGenerateBook").addEventListener("click", generateBookFromPlan);
       
    // sidebar
    els("btnNewProject").onclick = () => { createProject(); };
    els("projectSelect").onchange = (e) => setActiveProject(e.target.value);
    els("btnRenameProject").onclick = renameProject;
    els("btnDeleteProject").onclick = deleteProject;
    els("btnAutoChapters").onclick = autoSplitChapters;
    els("btnNewChapter").onclick = createChapter;
    els("chapterSelect").onchange = (e) => setActiveChapter(e.target.value);
    els("btnImportDocx").onclick = importDocx;
    els("btnExportDocx").onclick = exportDocx;
    els("btnQuickEdit").onclick = quickLineEdit;
    els("btnQuickContinue").onclick = quickContinue;
    els("btnQuickSummary").onclick = quickSummaryFacts;
    
    // write tab
    els("chapterTitle").oninput = (e) => updateChapterTitle(e.target.value);
    els("editor").oninput = (e) => updateChapterText(e.target.value);
    els("btnSelectAll").onclick = () => { const ta = els("editor"); ta.focus(); ta.select(); };
    els("btnSnapshot").onclick = snapshot;
    els("btnUndoSnapshot").onclick = restoreSnapshot;
    els("btnApplyAi").onclick = applyAiInsert;
    els("btnReplaceSelection").onclick = applyAiReplaceSelection;
    els("btnClearAi").onclick = clearAiOutput;
    
    // analysis tab
    els("btnRunAnalysis").onclick = runAnalysis;
    els("btnBuildStyleGuide").onclick = buildStyleGuide;
    els("btnCharacterBible").onclick = buildCharacterBible;
    
    // pipeline tab
    els("btnRunPipeline").onclick = runPipeline;
    els("btnDownloadPipeline").onclick = downloadPipeline;
    
    // research tab
    els("btnAskResearch").onclick = askResearch;
    
    // settings tab
    els("btnSaveKeys").onclick = saveKeys;
    els("btnForgetKeys").onclick = forgetKeys;
    els("btnSavePerf").onclick = savePerf;
    
    // logs
    els("btnClearLogs").onclick = () => { const st = store.get(); st.logs = []; store.set(st); renderLogs(); };
    els("btnExportLogs").onclick = exportLogs;
    
    // local model copy helpers
    els("btnCopyOllama1").onclick = async () => { await navigator.clipboard.writeText("ollama pull llama3.1"); toast("Copied"); };
    els("btnCopyOllama2").onclick = async () => { await navigator.clipboard.writeText("ollama pull mistral"); toast("Copied"); };
    els("btnCopyOllama3").onclick = async () => { await navigator.clipboard.writeText("ollama pull qwen2.5"); toast("Copied"); };
    
    // initialize
    renderAll();
    setStatus("Ready");
    log("App loaded");
}

init();

