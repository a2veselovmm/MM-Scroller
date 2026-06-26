/**
 * Photoshop-style WYSIWYG text editor (contenteditable).
 */

import { expandEmojiShortcodes } from "./emojiShortcodes.js";

/** @param {HTMLElement} editor */
export function hasSelectionIn(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer);
}

function stylesToCss(styles) {
  const css = {};
  if (styles.color != null) css.color = styles.color;
  if (styles.fontSize != null) {
    css.fontSize =
      typeof styles.fontSize === "number"
        ? `${styles.fontSize}px`
        : styles.fontSize;
  }
  if (styles.fontFamily != null) css.fontFamily = styles.fontFamily;
  if (styles.fontWeight != null) css.fontWeight = styles.fontWeight;
  if (styles.fontStyle != null) css.fontStyle = styles.fontStyle;
  if (styles.opacity != null) css.opacity = String(styles.opacity);
  if (styles.textShadow != null) css.textShadow = styles.textShadow;
  if (styles.webkitTextStroke != null) {
    css.webkitTextStroke = styles.webkitTextStroke;
    css.WebkitTextStroke = styles.webkitTextStroke;
  }
  if (styles.paintOrder != null) css.paintOrder = styles.paintOrder;
  if (styles.webkitTextStroke === "" || styles.webkitTextStroke === "unset") {
    css.webkitTextStroke = "initial";
    css.paintOrder = "initial";
  }
  return css;
}

/** @param {HTMLElement} el @param {Record<string, string>} css */
function applyCss(el, css) {
  for (const [k, v] of Object.entries(css)) {
    el.style[k] = v;
  }
}

/**
 * Apply inline styles to the current selection inside the editor.
 * @param {HTMLElement} editor
 * @param {object} styles
 */
export function applyStyleToSelection(editor, styles) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;

  const range = sel.getRangeAt(0);
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return false;
  }

  const css = stylesToCss(styles);

  const startSpan = findParentSpan(range.startContainer);
  const endSpan = findParentSpan(range.endContainer);

  if (
    startSpan &&
    startSpan === endSpan &&
    spanContainsRange(startSpan, range)
  ) {
    applyCss(startSpan, css);
    restoreSelection(range);
    return true;
  }

  const span = document.createElement("span");
  span.className = "text-run";
  applyCss(span, css);

  try {
    range.surroundContents(span);
  } catch {
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
  }

  sel.removeAllRanges();
  const nr = document.createRange();
  nr.selectNodeContents(span);
  nr.collapse(false);
  sel.addRange(nr);
  return true;
}

function findParentSpan(node) {
  let n = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (n && n !== document.body) {
    if (
      n.tagName === "SPAN" &&
      (n.classList.contains("text-run") || n.classList.contains("text-span"))
    ) {
      return n;
    }
    n = n.parentElement;
  }
  return null;
}

function spanContainsRange(span, range) {
  const r = document.createRange();
  r.selectNodeContents(span);
  return (
    range.compareBoundaryPoints(Range.START_TO_START, r) >= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, r) <= 0
  );
}

function restoreSelection(range) {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Ensure block lines use .text-line wrappers */
export function normalizeEditor(editor) {
  if (!editor.childNodes.length) {
    editor.innerHTML = '<div class="text-line"><br></div>';
    return;
  }

  const needsWrap = [...editor.childNodes].some(
    (n) =>
      n.nodeType === Node.TEXT_NODE ||
      (n.nodeType === Node.ELEMENT_NODE && !n.classList?.contains("text-line"))
  );

  if (!needsWrap) return;

  const lines = [];
  let buffer = "";

  const flush = () => {
    const t = buffer.replace(/\u00a0/g, " ").trimEnd();
    lines.push(t);
    buffer = "";
  };

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (el.tagName === "BR") {
      flush();
      return;
    }
    if (el.classList?.contains("text-line")) {
      flush();
      lines.push(el.innerHTML || "<br>");
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      flush();
      lines.push(el.innerHTML || "<br>");
      return;
    }
    for (const c of el.childNodes) walk(c);
  }

  for (const child of editor.childNodes) walk(child);
  flush();

  editor.innerHTML = lines
    .map((html) => {
      const inner = html.trim() ? html : "<br>";
      return `<div class="text-line">${inner}</div>`;
    })
    .join("");
}

/** @param {HTMLElement} editor @param {HTMLElement} preview */
export function syncEditorToPreview(editor, preview) {
  normalizeEditor(editor);
  preview.innerHTML = editor.innerHTML;
}

/** @param {HTMLElement} editor @param {HTMLElement} preview @param {object} layout */
export function applyLayoutStyles(editor, preview, layout) {
  const {
    fontFamily,
    fontSize,
    color,
    textAlign,
    lineHeight,
    letterSpacing,
    paddingH,
    defaultTextShadow,
    defaultStroke,
  } = layout;

  for (const el of [editor, preview]) {
    el.style.fontFamily = fontFamily;
    el.style.fontSize = `${fontSize}px`;
    el.style.color = color;
    el.style.textAlign = textAlign;
    el.style.lineHeight = String(lineHeight);
    el.style.letterSpacing = `${letterSpacing}px`;
    el.style.paddingLeft = `${paddingH}px`;
    el.style.paddingRight = `${paddingH}px`;
    el.style.boxSizing = "border-box";
    if (defaultTextShadow != null) el.style.textShadow = defaultTextShadow;
    if (defaultStroke?.webkitTextStroke) {
      el.style.webkitTextStroke = defaultStroke.webkitTextStroke;
      el.style.paintOrder = defaultStroke.paintOrder || "stroke fill";
    } else {
      el.style.webkitTextStroke = "";
      el.style.paintOrder = "";
    }
  }
}

function rangeIntersectsNode(range, node) {
  try {
    return range.intersectsNode(node);
  } catch {
    const r = document.createRange();
    r.selectNodeContents(node);
    return (
      range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, r) > 0
    );
  }
}

function isBold(weight) {
  const n = parseInt(weight, 10);
  return !Number.isNaN(n) ? n >= 600 : weight === "bold" || weight === "bolder";
}

function collectValuesInRange(range, editor) {
  const weights = new Set();
  const fontStyles = new Set();
  const colors = new Set();
  const sizes = new Set();
  const opacities = new Set();

  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    if (!rangeIntersectsNode(range, node)) {
      node = walker.nextNode();
      continue;
    }

    let el = node.parentElement;
    while (el && el !== editor) {
      if (el.tagName === "SPAN" || el === editor) break;
      el = el.parentElement;
    }
    if (!el) el = editor;

    const cs = getComputedStyle(el);
    weights.add(cs.fontWeight);
    fontStyles.add(cs.fontStyle);
    colors.add(cs.color);
    sizes.add(parseFloat(cs.fontSize));
    opacities.add(parseFloat(cs.opacity));
    node = walker.nextNode();
  }

  if (!weights.size) {
    const cs = getComputedStyle(editor);
    weights.add(cs.fontWeight);
    fontStyles.add(cs.fontStyle);
    colors.add(cs.color);
    sizes.add(parseFloat(cs.fontSize));
    opacities.add(parseFloat(cs.opacity));
  }

  return { weights, fontStyles, colors, sizes, opacities };
}

function uniformValue(set) {
  if (set.size === 0) return { value: null, mixed: false };
  if (set.size === 1) return { value: [...set][0], mixed: false };
  return { value: null, mixed: true };
}

/**
 * Read styles for the current selection (or caret).
 * bold/italic: true | false | "mixed"
 */
export function getSelectionStyles(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;

  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;

  const { weights, fontStyles, colors, sizes, opacities } =
    collectValuesInRange(range, editor);

  const w = uniformValue(weights);
  const fs = uniformValue(fontStyles);
  const c = uniformValue(colors);
  const sz = uniformValue(sizes);
  const op = uniformValue(opacities);

  let bold = false;
  if (w.mixed) bold = "mixed";
  else bold = isBold(w.value);

  let italic = false;
  if (fs.mixed) italic = "mixed";
  else italic = fs.value === "italic";

  return {
    color: c.mixed ? null : c.value,
    fontSize: sz.mixed ? null : sz.value,
    fontWeight: w.mixed ? null : w.value,
    fontStyle: fs.mixed ? null : fs.value,
    opacity: op.mixed ? null : op.value,
    bold,
    italic,
    hasSelection: !range.collapsed,
  };
}

/** @deprecated use getSelectionStyles */
export function getStyleAtCursor(editor) {
  return getSelectionStyles(editor);
}

/** Extract plain text with line breaks from styled HTML */
export function htmlToPlain(htmlOrElement) {
  const root =
    typeof htmlOrElement === "string"
      ? (() => {
          const d = document.createElement("div");
          d.innerHTML = htmlOrElement;
          return d;
        })()
      : htmlOrElement;

  const lines = root.querySelectorAll(".text-line");
  if (lines.length) {
    return [...lines]
      .map((line) => line.textContent.replace(/\u00a0/g, " "))
      .join("\n");
  }
  return (root.textContent || "").replace(/\u00a0/g, " ");
}

/** Build styled line blocks from plain text (default styling only) */
export function plainToHtml(text) {
  const expanded = expandEmojiShortcodes(text ?? "");
  const escaped = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  if (!expanded) return '<div class="text-line"><br></div>';

  return expanded.split("\n").map((line) => {
    const inner = line.length ? escaped(line) : "<br>";
    return `<div class="text-line">${inner}</div>`;
  }).join("");
}

/** Demo document */
export function defaultEditorHtml() {
  return `
<div class="text-line"><span class="text-run" style="color:#FFD700;font-size:48px;font-weight:700">MM-Scroller</span></div>
<div class="text-line">Line one of your credits</div>
<div class="text-line"><span class="text-run" style="color:#a8d8ff;font-size:40px">Line two — styled separately</span></div>
<div class="text-line">Line three — cinematic feel</div>
<div class="text-line"><br></div>
<div class="text-line">Select text and change color, size, or font — updates live.</div>
`.trim();
}
