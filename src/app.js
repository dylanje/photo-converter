// Photo Converter UI. No frameworks, no network calls, no analytics.
// The CSP in tauri.conf.json blocks all outside connections.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { open } = window.__TAURI__.dialog;
  const webview = window.__TAURI__.webview.getCurrentWebview();

  // Replaced at startup with whatever this build of the app can actually open.
  let INPUT_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff"];
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
    list: $("list"), count: $("count"), selectAll: $("selectAll"), clear: $("clear"), formats: $("formats"),
    qualityField: $("qualityField"), quality: $("quality"), qualityValue: $("qualityValue"),
    qualityNote: $("qualityNote"), outBtn: $("outBtn"), outReset: $("outReset"),
    convert: $("convert"), stats: $("stats"), hint: $("inputHint"),
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
    const total = state.files.length;
    const picked = state.files.filter((f) => f.selected).length;
    el.count.textContent = picked === total
      ? `${total} photo${total === 1 ? "" : "s"}`
      : `${picked} of ${total} selected`;
    el.selectAll.checked = total > 0 && picked === total;
    el.selectAll.indeterminate = picked > 0 && picked < total;
    el.selectAll.disabled = state.busy;
    el.convert.disabled = state.busy || picked === 0;
    el.convert.textContent = state.busy
      ? "Converting…"
      : picked === 0 ? "Convert" : picked === 1 ? "Convert 1 photo" : `Convert ${picked} photos`;
    el.clear.hidden = state.busy;
  }

  function renderList() {
    const has = state.files.length > 0;
    el.app.classList.toggle("has-files", has);
    el.listWrap.hidden = !has;
    el.list.textContent = "";
    for (const f of state.files) {
      const li = document.createElement("li");
      li.className = `item ${f.status}`;

      const pick = document.createElement("label");
      pick.className = "pick";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = f.selected;
      box.disabled = state.busy;
      box.addEventListener("change", () => { f.selected = box.checked; renderControls(); });
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = f.name;
      name.title = f.path;
      pick.append(box, name);

      const status = document.createElement("div");
      status.className = "status";
      if (f.status === "working") {
        const spin = document.createElement("span");
        spin.className = "spinner";
        status.appendChild(spin);
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

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "icon-btn rm";
      rm.textContent = "\u00d7";
      rm.title = "Remove from list";
      rm.setAttribute("aria-label", `Remove ${f.name}`);
      rm.disabled = state.busy;
      rm.addEventListener("click", () => {
        state.files = state.files.filter((x) => x !== f);
        renderList();
      });

      li.append(pick, status, rm);
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
      state.files.push({ path: p, name: baseName(p), status: "pending", selected: true });
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
    const queue = state.files.filter((f) => f.selected);
    if (state.busy || queue.length === 0) return;
    state.busy = true;
    queue.forEach((f) => { f.status = "pending"; delete f.error; delete f.output; });
    renderList();
    let ok = 0;
    for (const f of queue) {
      f.status = "working";
      renderList();
      try {
        f.output = await invoke("convert_one", {
          path: f.path, target: state.format, quality: state.quality, outDir: state.outDir,
        });
        f.status = "done";
        f.selected = false; // converted once: leave it unchecked so it isn't redone by accident
        ok += 1;
      } catch (e) {
        f.status = "error"; // stays checked so the next Convert retries it
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
  el.selectAll.addEventListener("change", () => {
    if (state.busy) return;
    state.files.forEach((f) => { f.selected = el.selectAll.checked; });
    renderList();
  });
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

  function renderInputHint() {
    const names = { jpg: "JPG", png: "PNG", webp: "WebP", gif: "GIF", bmp: "BMP", tiff: "TIFF", heic: "HEIC", avif: "AVIF" };
    const shown = [...new Set(INPUT_EXT.map((e) => (e === "jpeg" ? "jpg" : e === "tif" ? "tiff" : e === "heif" ? "heic" : e)))];
    el.hint.textContent = shown.map((e) => names[e] || e.toUpperCase()).join(", ");
  }

  renderFormats();
  renderList();
  renderStats();
  renderInputHint();
  invoke("input_formats").then((list) => { INPUT_EXT = list; renderInputHint(); }).catch(() => {});
})();
