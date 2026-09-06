/**
 * Self-contained HTML document for the rich-text editor. It is loaded inside a
 * WebView on native and an iframe on web, so the SAME editing engine runs on
 * every platform. Communication is JSON messages:
 *   host -> editor : window.handleCommand({type, ...})
 *   editor -> host : {type: 'ready'|'change'|'height'|'state'|'caret'|'focus'|'blur'}
 */
export const EDITOR_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  :root { --fg:#181715; --muted:#8A8781; --brand:#E27429; --hl:#FFE58A; }
  html, body { margin:0; padding:0; background:transparent; overflow-x:hidden; }
  body { font-family:-apple-system, BlinkMacSystemFont, Roboto, 'Segoe UI', sans-serif; font-size:17px; line-height:1.6; color:var(--fg); -webkit-text-size-adjust:100%; }
  #editor { outline:none; border:0; min-height:160px; padding:2px 0 40px 0; word-wrap:break-word; overflow-wrap:anywhere; caret-color:var(--brand); position:relative; }
  #editor.empty:before { content:attr(data-placeholder); color:var(--muted); position:absolute; left:0; top:2px; pointer-events:none; }
  #editor > div, #editor > p { margin:0; min-height:1.6em; }
  h1 { font-size:26px; line-height:1.3; font-weight:800; margin:14px 0 6px; }
  h2 { font-size:22px; line-height:1.3; font-weight:700; margin:12px 0 4px; }
  h3 { font-size:19px; line-height:1.35; font-weight:700; margin:10px 0 4px; }
  ul, ol { margin:4px 0; padding-left:26px; }
  li { margin:2px 0; }
  blockquote { margin:6px 0; padding-left:12px; border-left:3px solid var(--brand); color:var(--muted); }
  mark { background:var(--hl); color:inherit; border-radius:3px; padding:0 2px; }
  b, strong { font-weight:700; }
  * { -webkit-tap-highlight-color:transparent; }
  ::selection { background: rgba(226,116,41,0.25); }
</style></head>
<body>
<div id="editor" contenteditable="true" data-placeholder="Start writing…" spellcheck="true" autocapitalize="sentences"></div>
<script>
(function(){
  var editor = document.getElementById('editor');
  var HL = '#FFE58A';
  var lastHeight = 0;
  var savedRange = null;

  function post(msg){
    var s = JSON.stringify(msg);
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(s); return; }
    } catch(e){}
    try { if (window.parent && window.parent !== window) window.parent.postMessage(s, '*'); } catch(e){}
  }

  try { document.execCommand('styleWithCSS', false, false); } catch(e){}
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch(e){}

  // ---------- sanitizer ----------
  var ALLOWED = {b:1,i:1,u:1,s:1,mark:1,h1:1,h2:1,h3:1,ul:1,ol:1,li:1,div:1,p:1,br:1,blockquote:1};
  var RENAME = {strong:'b',em:'i',strike:'s',del:'s',h4:'h3',h5:'h3',h6:'h3'};
  function sanitizeNode(node){
    var children = Array.prototype.slice.call(node.childNodes);
    for (var i=0;i<children.length;i++){
      var ch = children[i];
      if (ch.nodeType === 3) continue;
      if (ch.nodeType !== 1) { node.removeChild(ch); continue; }
      var tag = ch.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'img' || tag === 'iframe' || tag === 'object' || tag === 'input' || tag === 'button') { node.removeChild(ch); continue; }
      if (RENAME[tag]) tag = RENAME[tag];
      var bg = ch.style && ch.style.backgroundColor;
      var fw = ch.style && ch.style.fontWeight;
      var fs = ch.style && ch.style.fontStyle;
      var td = ch.style && ch.style.textDecorationLine || (ch.style && ch.style.textDecoration) || '';
      if ((tag === 'span' || tag === 'font') && bg && bg !== 'transparent' && bg !== 'initial' && bg !== 'inherit') tag = 'mark';
      else if ((tag === 'span' || tag === 'font') && fw && (fw === 'bold' || parseInt(fw,10) >= 600)) tag = 'b';
      else if ((tag === 'span' || tag === 'font') && fs === 'italic') tag = 'i';
      else if ((tag === 'span' || tag === 'font') && td.indexOf('underline') >= 0) tag = 'u';
      else if ((tag === 'span' || tag === 'font') && td.indexOf('line-through') >= 0) tag = 's';
      if (!ALLOWED[tag]) {
        // unwrap: keep children
        sanitizeNode(ch);
        while (ch.firstChild) node.insertBefore(ch.firstChild, ch);
        node.removeChild(ch);
        continue;
      }
      var el = ch;
      if (ch.tagName.toLowerCase() !== tag) {
        el = document.createElement(tag);
        while (ch.firstChild) el.appendChild(ch.firstChild);
        node.replaceChild(el, ch);
      }
      while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
      sanitizeNode(el);
    }
  }
  function getHTML(){
    var clone = editor.cloneNode(true);
    sanitizeNode(clone);
    var html = clone.innerHTML;
    if (isBlank()) return '';
    return html;
  }
  function isBlank(){
    var t = editor.textContent || '';
    return t.split(String.fromCharCode(160)).join(' ').trim() === '';
  }
  function updateEmpty(){
    if (isBlank()) editor.classList.add('empty'); else editor.classList.remove('empty');
  }

  // ---------- reporting ----------
  function reportHeight(){
    var h = Math.ceil(editor.getBoundingClientRect().height) + 4;
    if (h !== lastHeight){ lastHeight = h; post({type:'height', height:h}); }
  }
  function q(cmd){ try { return !!document.queryCommandState(cmd); } catch(e){ return false; } }
  function blockTag(){
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode) return '';
    var n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    while (n && n !== editor){
      var t = n.tagName ? n.tagName.toLowerCase() : '';
      if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'blockquote') return t;
      n = n.parentNode;
    }
    return '';
  }
  function inMark(){
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode) return false;
    var n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    while (n && n !== editor){ if (n.tagName && n.tagName.toLowerCase() === 'mark') return true; n = n.parentNode; }
    return false;
  }
  function canUndo(){ try { return document.queryCommandEnabled('undo'); } catch(e){ return false; } }
  function canRedo(){ try { return document.queryCommandEnabled('redo'); } catch(e){ return false; } }
  function reportState(){
    var bt = blockTag();
    post({type:'state', state:{
      bold:q('bold'), italic:q('italic'), underline:q('underline'), strike:q('strikeThrough'),
      ul:q('insertUnorderedList'), ol:q('insertOrderedList'),
      h1:bt==='h1', h2:bt==='h2', h3:bt==='h3', quote:bt==='blockquote', mark:inMark(),
      canUndo:canUndo(), canRedo:canRedo()
    }});
  }
  function reportCaret(){
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0).cloneRange();
    var rect = range.getBoundingClientRect();
    var top = rect.top, bottom = rect.bottom;
    if ((!rect.height && !rect.top) || (rect.top === 0 && rect.bottom === 0)) {
      var n = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
      if (n && n.getBoundingClientRect) { var r = n.getBoundingClientRect(); top = r.top; bottom = r.bottom; }
    }
    post({type:'caret', top: top + window.scrollY, bottom: bottom + window.scrollY});
  }
  function saveRange(){
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreRange(){
    if (!savedRange) return;
    try { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } catch(e){}
  }

  var changeTimer = null;
  function emitChange(){
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(function(){ post({type:'change', html:getHTML()}); }, 120);
  }

  editor.addEventListener('input', function(){ updateEmpty(); emitChange(); reportHeight(); reportState(); reportCaret(); });
  editor.addEventListener('keyup', function(){ reportState(); reportCaret(); });
  editor.addEventListener('mouseup', function(){ reportState(); reportCaret(); });
  editor.addEventListener('touchend', function(){ setTimeout(function(){ reportState(); reportCaret(); }, 0); });
  editor.addEventListener('focus', function(){ post({type:'focus'}); reportState(); });
  editor.addEventListener('blur', function(){ saveRange(); post({type:'blur'}); });
  document.addEventListener('selectionchange', function(){ saveRange(); reportState(); reportCaret(); });
  editor.addEventListener('paste', function(e){
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });
  editor.addEventListener('drop', function(e){ e.preventDefault(); });
  // Keep the visible document from scrolling itself; the host scroll view scrolls.
  window.addEventListener('scroll', function(){ if (window.scrollY) window.scrollTo(0,0); });
  if (window.ResizeObserver) { new ResizeObserver(reportHeight).observe(editor); }

  // ---------- commands ----------
  function focusEditor(){
    editor.focus();
    restoreRange();
  }
  function toggleBlock(tag){
    var cur = blockTag();
    document.execCommand('formatBlock', false, cur === tag ? 'div' : tag);
  }
  function toggleMark(){
    if (inMark()){
      var sel = window.getSelection();
      var n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
      while (n && n !== editor && !(n.tagName && n.tagName.toLowerCase() === 'mark')) n = n.parentNode;
      if (n && n !== editor){ var p = n.parentNode; while (n.firstChild) p.insertBefore(n.firstChild, n); p.removeChild(n); }
    } else {
      var s = window.getSelection();
      if (!s || s.isCollapsed) return;
      document.execCommand('hiliteColor', false, HL);
      // normalise span->mark immediately so state reporting works
      var spans = editor.querySelectorAll('span[style*="background"], font[style*="background"]');
      for (var i=0;i<spans.length;i++){ var m = document.createElement('mark'); while (spans[i].firstChild) m.appendChild(spans[i].firstChild); spans[i].parentNode.replaceChild(m, spans[i]); }
    }
  }
  window.handleCommand = function(cmd){
    try {
      if (typeof cmd === 'string') cmd = JSON.parse(cmd);
      switch(cmd.type){
        case 'setHTML':
          editor.innerHTML = cmd.html || '';
          sanitizeNode(editor);
          updateEmpty(); reportHeight(); reportState();
          break;
        case 'setPlaceholder': editor.setAttribute('data-placeholder', cmd.text || ''); break;
        case 'setTheme':
          var r = document.documentElement.style;
          if (cmd.fg) r.setProperty('--fg', cmd.fg);
          if (cmd.muted) r.setProperty('--muted', cmd.muted);
          if (cmd.brand) r.setProperty('--brand', cmd.brand);
          if (cmd.hl) { r.setProperty('--hl', cmd.hl); HL = cmd.hl; }
          break;
        case 'focus': focusEditor(); break;
        case 'blur': editor.blur(); break;
        case 'exec':
          focusEditor();
          var name = cmd.name;
          if (name === 'h1' || name === 'h2' || name === 'h3' || name === 'blockquote') toggleBlock(name);
          else if (name === 'mark') toggleMark();
          else document.execCommand(name, false, cmd.value == null ? null : cmd.value);
          updateEmpty(); emitChange(); reportHeight(); reportState(); reportCaret();
          break;
        case 'getHTML': post({type:'html', html:getHTML(), id: cmd.id}); break;
      }
    } catch(e){ post({type:'error', message: String(e && e.message || e)}); }
  };
  window.addEventListener('message', function(e){
    var d = e.data; if (!d) return;
    try { window.handleCommand(typeof d === 'string' ? JSON.parse(d) : d); } catch(err){}
  });

  updateEmpty();
  post({type:'ready'});
  reportHeight();
})();
</script>
</body></html>`;

export interface EditorFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  ul: boolean;
  ol: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  quote: boolean;
  mark: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export const EMPTY_FORMAT_STATE: EditorFormatState = {
  bold: false, italic: false, underline: false, strike: false, ul: false, ol: false,
  h1: false, h2: false, h3: false, quote: false, mark: false, canUndo: false, canRedo: false,
};

export type EditorCommand =
  | "bold" | "italic" | "underline" | "strikeThrough"
  | "insertUnorderedList" | "insertOrderedList"
  | "h1" | "h2" | "h3" | "blockquote" | "mark"
  | "undo" | "redo";

export interface EditorTheme {
  fg: string;
  muted: string;
  brand: string;
  hl: string;
}

export interface RichTextEditorProps {
  initialHtml: string;
  onChange: (html: string) => void;
  onState?: (state: EditorFormatState) => void;
  /** Caret bottom (px) relative to the top of the editor. */
  onCaret?: (bottom: number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  theme: EditorTheme;
  minHeight?: number;
  testID?: string;
}

export interface RichTextEditorHandle {
  exec: (name: EditorCommand, value?: string) => void;
  setHTML: (html: string) => void;
  focus: () => void;
  blur: () => void;
}
