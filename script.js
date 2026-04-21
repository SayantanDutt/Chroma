// Image Color Extractor — vanilla JS
// Pipeline: upload -> draw to canvas (downscaled) -> k-means on pixels -> render palette

(() => {
  "use strict";

  // DOM references
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const colorCountInput = document.getElementById("color-count");
  const colorCountValue = document.getElementById("color-count-value");
  const results = document.getElementById("results");
  const preview = document.getElementById("preview");
  const paletteEl = document.getElementById("palette");
  const copyAllBtn = document.getElementById("copy-all");
  const downloadBtn = document.getElementById("download-palette");
  const loader = document.getElementById("loader");
  const errorEl = document.getElementById("error-message");
  const toast = document.getElementById("toast");
  const canvas = document.getElementById("work-canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Holds the current decoded image so re-extracting on slider change is cheap
  let currentImage = null;
  // Current palette (array of {r,g,b})
  let currentPalette = [];

  const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  const SAMPLE_SIZE = 100; // downscale target (pixels per side)
  const KMEANS_ITERATIONS = 10;

  // ---------- Event wiring ----------
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Drag & drop styling + handling
  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    })
  );
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleUpload(file);
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleUpload(file);
  });

  colorCountInput.addEventListener("input", () => {
    colorCountValue.textContent = colorCountInput.value;
  });
  colorCountInput.addEventListener("change", () => {
    if (currentImage) runExtraction();
  });

  copyAllBtn.addEventListener("click", () => {
    if (!currentPalette.length) return;
    const hexList = currentPalette.map(rgbToHex).join(", ");
    copyToClipboard(hexList);
  });

  downloadBtn.addEventListener("click", downloadPalette);

  // ---------- Upload handling ----------
  function handleUpload(file) {
    hideError();

    if (!file || !ACCEPTED_TYPES.includes(file.type)) {
      showError("Please upload a valid image (PNG, JPG, JPEG, or WEBP).");
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => showError("Could not read the file. Please try again.");
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        currentImage = img;
        preview.src = img.src;
        runExtraction();
      };
      img.onerror = () => showError("That file doesn't appear to be a valid image.");
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- Extraction orchestrator ----------
  function runExtraction() {
    showLoader();
    // Defer so the spinner paints before heavy work starts
    setTimeout(() => {
      try {
        const k = parseInt(colorCountInput.value, 10);
        currentPalette = extractColors(currentImage, k);
        renderPalette(currentPalette);
        results.classList.remove("hidden");
      } catch (err) {
        console.error(err);
        showError("Something went wrong while extracting colors.");
      } finally {
        hideLoader();
      }
    }, 20);
  }

  // ---------- Color extraction (draw -> sample -> k-means) ----------
  function extractColors(img, k) {
    // Downscale to SAMPLE_SIZE keeping aspect ratio for performance
    const ratio = img.width / img.height;
    let w, h;
    if (ratio >= 1) {
      w = SAMPLE_SIZE;
      h = Math.max(1, Math.round(SAMPLE_SIZE / ratio));
    } else {
      h = SAMPLE_SIZE;
      w = Math.max(1, Math.round(SAMPLE_SIZE * ratio));
    }

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);

    // Collect RGB pixels, skipping fully transparent ones
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 125) continue;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }

    if (pixels.length === 0) {
      return [];
    }

    const centroids = kMeans(pixels, k, KMEANS_ITERATIONS);

    // Sort darkest -> lightest using perceived luminance
    centroids.sort((a, b) => luminance(a) - luminance(b));

    return centroids.map(([r, g, b]) => ({
      r: Math.round(r),
      g: Math.round(g),
      b: Math.round(b),
    }));
  }

  // ---------- K-means clustering on RGB triples ----------
  function kMeans(pixels, k, iterations) {
    const n = pixels.length;
    const effectiveK = Math.min(k, n);

    // Initialize centroids using k-means++-lite: pick first at random, then pick
    // subsequent centroids biased toward points far from existing ones. This
    // gives better, more varied palettes than pure random seeding.
    const centroids = [];
    centroids.push(pixels[Math.floor(Math.random() * n)].slice());

    while (centroids.length < effectiveK) {
      const distances = new Array(n);
      let total = 0;
      for (let i = 0; i < n; i++) {
        let best = Infinity;
        for (let c = 0; c < centroids.length; c++) {
          const d = squaredDist(pixels[i], centroids[c]);
          if (d < best) best = d;
        }
        distances[i] = best;
        total += best;
      }
      // Weighted pick
      let target = Math.random() * total;
      let chosen = 0;
      for (let i = 0; i < n; i++) {
        target -= distances[i];
        if (target <= 0) {
          chosen = i;
          break;
        }
      }
      centroids.push(pixels[chosen].slice());
    }

    const assignments = new Array(n).fill(0);

    for (let iter = 0; iter < iterations; iter++) {
      // Assign each pixel to nearest centroid
      let moved = false;
      for (let i = 0; i < n; i++) {
        let best = 0;
        let bestDist = Infinity;
        for (let c = 0; c < centroids.length; c++) {
          const d = squaredDist(pixels[i], centroids[c]);
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
        if (assignments[i] !== best) {
          assignments[i] = best;
          moved = true;
        }
      }

      // Recompute centroids as mean of their members
      const sums = Array.from({ length: centroids.length }, () => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const a = assignments[i];
        const p = pixels[i];
        sums[a][0] += p[0];
        sums[a][1] += p[1];
        sums[a][2] += p[2];
        sums[a][3] += 1;
      }
      for (let c = 0; c < centroids.length; c++) {
        if (sums[c][3] > 0) {
          centroids[c][0] = sums[c][0] / sums[c][3];
          centroids[c][1] = sums[c][1] / sums[c][3];
          centroids[c][2] = sums[c][2] / sums[c][3];
        } else {
          // Re-seed empty cluster with a random pixel
          const p = pixels[Math.floor(Math.random() * n)];
          centroids[c] = p.slice();
        }
      }

      if (!moved && iter > 0) break;
    }

    return centroids;
  }

  function squaredDist(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  // ---------- Rendering ----------
  function renderPalette(colors) {
    paletteEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    colors.forEach((c) => {
      const hex = rgbToHex(c);
      const rgbStr = `rgb(${c.r}, ${c.g}, ${c.b})`;
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const hslStr = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;

      const swatch = document.createElement("div");
      swatch.className = "swatch";

      const color = document.createElement("div");
      color.className = "swatch-color";
      color.style.background = hex;
      color.title = `${hex} • ${rgbStr} • ${hslStr}`;

      const info = document.createElement("div");
      info.className = "swatch-info";

      info.appendChild(makeCode(hex));
      info.appendChild(makeCode(rgbStr));
      info.appendChild(makeCode(hslStr));

      swatch.appendChild(color);
      swatch.appendChild(info);
      frag.appendChild(swatch);
    });

    paletteEl.appendChild(frag);
  }

  function makeCode(text) {
    const el = document.createElement("code");
    el.textContent = text;
    el.addEventListener("click", () => copyToClipboard(text));
    return el;
  }

  // ---------- Clipboard ----------
  function copyToClipboard(text) {
    // Prefer async clipboard API; fall back to a temporary textarea
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        () => showToast("Copied!"),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast("Copied!");
    } catch {
      showToast("Copy failed");
    }
    document.body.removeChild(ta);
  }

  // ---------- Download palette as CSS ----------
  function downloadPalette() {
    if (!currentPalette.length) return;

    const lines = [":root {"];
    currentPalette.forEach((c, i) => {
      lines.push(`  --color-${i + 1}: ${rgbToHex(c)};`);
    });
    lines.push("}");
    const cssText = lines.join("\n");

    const blob = new Blob([cssText], { type: "text/css" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "palette.css";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Color utilities ----------
  function rgbToHex({ r, g, b }) {
    return (
      "#" +
      [r, g, b]
        .map((v) => {
          const h = Math.max(0, Math.min(255, Math.round(v))).toString(16);
          return h.length === 1 ? "0" + h : h;
        })
        .join("")
        .toUpperCase()
    );
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h *= 60;
    }

    return {
      h: Math.round(h),
      s: Math.round(s * 100),
      l: Math.round(l * 100),
    };
  }

  // Perceived brightness — Rec. 709 luma
  function luminance(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  // ---------- UI helpers ----------
  function showLoader() {
    loader.classList.remove("hidden");
  }
  function hideLoader() {
    loader.classList.add("hidden");
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }
  function hideError() {
    errorEl.classList.add("hidden");
    errorEl.textContent = "";
  }

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    // Force a reflow so the transition runs even if .show was just removed
    void toast.offsetWidth;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.classList.add("hidden"), 200);
    }, 1400);
  }
})();
