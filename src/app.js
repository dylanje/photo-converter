// Photo Converter UI. No frameworks, no network calls, no analytics.
// The CSP in tauri.conf.json blocks all outside connections.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { open } = window.__TAURI__.dialog;
  const webview = window.__TAURI__.webview.getCurrentWebview();

  const INPUT_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff"];
  const FORMATS = [
    { id: "jpeg", label: "JPG", lossy: true },
    { id: "png", label: "PNG" },
    { id: "webp", label: "WebP", note: "WebP is saved lossless, so quality does not apply." },
    { id: "avif", label: "AVIF", lossy: true },
    { id: "bmp", label: "BMP" },
    { id: "tiff", label: "TIFF" },
    { id: "gif", label: "GIF", note: "GIF is limited to 256 colors, so photos lose detail." },
  ];

  const state = { files: [], format: "jpeg", quality: 90, outDir: null, busy: false };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $("app"), drop: $("drop"), browse: $("browse"), listWrap: $("listWrap"),
    list: $("list"), count: $("count"), clear: $("clear"), formats: $("formats"),
    qualityField: $("qualityField"), quality: $("quality"), qualityValue: $("qualityValue"),
    qualityNote: $("qualityNote"), outBtn: $("outBtn"), outReset: $("outReset"),
    convert: $("convert"), stats: $("stats"),
  };

  const baseName = (p) => p.split(/[\\/]/).pop();
  const extOf = (p) => (baseName(p).split(".").pop() || "").toLowerCase();
  const fmt = () => FORMATS.find((f) => f.id === state.format);

  // --- Local-only counter. Stored on this device, never transmitted. ---
  const STAT_KEY = "convertedCount";
  function getCount() {
    try { return Number(localStorage.getItem(STAT_KEY)) || 0; } catch { return 0; }
  }
  function bumpCount(n) {
    try { localStorage.setItem(STAT_KEY, String(getCount() + n)); } catch { /* ignore */ }
  }
  function renderStats() {
    const n = getCount();
    el.stats.textContent = n > 0
      ? `${n.toLocaleString()} photo${n === 1 ? "" : "s"} converted on this device. Nothing ever leaves it.`
      : "Everything stays on this device.";
  }

  // --- Rendering ---
  function renderFormats() {
    el.formats.textContent = "";
    for (const f of FORMATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(f.id === state.format));
      b.textContent = f.label;
      b.addEventListener("click", () => { state.format = f.id; renderFormats(); renderControls(); });
      el.formats.appendChild(b);
    }
  }

  function renderControls() {
    const f = fmt();
    el.qualityField.classList.toggle("off", !f.lossy);
    el.qualityNote.textContent = f.note || "";
    el.qualityValue.textContent = state.quality;
    el.outBtn.textContent = state.outDir ? baseName(state.outDir) || state.outDir : "Next to original";
    el.outBtn.title = state.outDir || "Converted files are saved beside the originals";
    el.outReset.hidden = !state.outDir;
    const n = state.files.length;
    el.convert.disabled = state.busy || n === 0;
    el.convert.textContent = state.busy ? "Converting…" : n > 1 ? `Convert ${n} photos` : "Convert";
    el.clear.hidden = state.busy;
  }

  function renderList() {
    const has = state.files.length > 0;
    el.app.classList.toggle("has-files", has);
    el.listWrap.hidden = !has;
    el.count.textContent = `${state.files.length} photo${state.files.length === 1 ? "" : "s"}`;
    el.list.textContent = "";
    for (const f of state.files) {
      const li = document.createElement("li");
      li.className = `item ${f.status}`;
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = f.name;
      name.title = f.path;
      const status = document.createElement("div");
      status.className = "status";
      if (f.status === "working") {
        const s = document.createElement("span");
        s.className = "spinner";
        status.appendChild(s);
      }
      const msg = document.createElement("span");
      msg.className = "msg";
      msg.style.color = "inherit";
      msg.textContent =
        f.status === "done" ? `Saved as ${baseName(f.output)}` :
        f.status === "error" ? f.error :
        f.status === "working" ? "Converting…" : "Ready";
      msg.title = msg.textContent;
      status.appendChild(msg);
      li.append(name, status);
      el.list.appendChild(li);
    }
    renderControls();
  }

  // --- Actions ---
  function addPaths(paths) {
    if (state.busy) return;
    const known = new Set(state.files.map((f) => f.path));
    for (const p of paths) {
      if (!INPUT_EXT.includes(extOf(p)) || known.has(p)) continue;
      known.add(p);
      state.files.push({ path: p, name: baseName(p), status: "pending" });
    }
    renderList();
  }

  async function browse() {
    if (state.busy) return;
    const picked = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: INPUT_EXT }],
    });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function chooseOutDir() {
    const dir = await open({ directory: true, multiple: false });
    if (dir) { state.outDir = dir; renderControls(); }
  }

  async function convertAll() {
    state.busy = true;
    state.files.forEach((f) => { f.status = "pending"; delete f.error; delete f.output; });
    renderList();
    let ok = 0;
    for (const f of state.files) {
      f.status = "working";
      renderList();
      try {
        f.output = await invoke("convert_one", {
          path: f.path, target: state.format, quality: state.quality, outDir: state.outDir,
        });
        f.status = "done";
        ok += 1;
      } catch (e) {
        f.status = "error";
        f.error = String(e);
      }
      renderList();
    }
    bumpCount(ok);
    state.busy = false;
    renderList();
    renderStats();
  }

  // --- Wiring ---
  el.browse.addEventListener("click", (e) => { e.stopPropagation(); browse(); });
  el.drop.addEventListener("click", browse);
  el.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse(); }
  });
  el.clear.addEventListener("click", () => { state.files = []; renderList(); });
  el.quality.addEventListener("input", () => { state.quality = Number(el.quality.value); renderControls(); });
  el.outBtn.addEventListener("click", chooseOutDir);
  el.outReset.addEventListener("click", () => { state.outDir = null; renderControls(); });
  el.convert.addEventListener("click", convertAll);

  webview.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") el.drop.classList.add("hot");
    else if (p.type === "leave") el.drop.classList.remove("hot");
    else if (p.type === "drop") { el.drop.classList.remove("hot"); addPaths(p.paths); }
  });

  renderFormats();
  renderList();
  renderStats();
})();
