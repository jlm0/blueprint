export interface PaintRow {
  name: string;
  before: string;
  after: string;
  body?: string;
  beforeBody?: string;
  /** The pixels of a running animation depend on the moment of the capture, so this row reads the diff alone. */
  motion?: boolean;
}

const P = '<p class="a" style="width:300px;height:40px;margin:0">Text in a line</p>';
const LIST = '<ul style="margin:0 0 0 40px;padding:0"><li class="a">Text</li></ul>';
const FIELD = '<input class="a" placeholder="Text" style="width:200px">';
const BOX = '<div class="a" style="width:120px;height:80px"></div>';
const GRAD = 'linear-gradient(red, blue)';
const IMG = '<img class="a" alt="" width="120" height="120" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==">';

export const PAINT_ROWS: PaintRow[] = [
  { name: 'direction rtl', before: '.a { direction: ltr; }', after: '.a { direction: rtl; }', body: P },
  { name: 'dir attribute on p', before: '', after: '', beforeBody: '<p dir="ltr" style="width:300px;height:40px;margin:0">Text</p>', body: '<p dir="rtl" style="width:300px;height:40px;margin:0">Text</p>' },
  { name: 'writing-mode in fixed box', before: '.a { writing-mode: horizontal-tb; }', after: '.a { writing-mode: vertical-rl; }', body: '<p class="a" style="width:100px;height:100px;margin:0">Text</p>' },
  { name: 'border-image', before: `.a { border: 10px solid transparent; }`, after: `.a { border: 10px solid transparent; border-image: ${GRAD} 1; }`, body: BOX },
  { name: 'background-blend-mode', before: `.a { background: ${GRAD}, green; }`, after: `.a { background: ${GRAD}, green; background-blend-mode: multiply; }`, body: BOX },
  { name: 'background-origin', before: `.a { padding: 20px; box-sizing: border-box; background: ${GRAD} no-repeat; background-size: 20px 20px; }`, after: `.a { padding: 20px; box-sizing: border-box; background: ${GRAD} no-repeat; background-size: 20px 20px; background-origin: content-box; }`, body: BOX },
  { name: 'background-attachment', before: `.a { background: ${GRAD}; }`, after: `.a { background: ${GRAD}; background-attachment: fixed; }`, body: BOX },
  { name: 'mask-position', before: `.a { background: red; mask-image: ${GRAD}; mask-size: 50% 50%; mask-repeat: no-repeat; }`, after: `.a { background: red; mask-image: ${GRAD}; mask-size: 50% 50%; mask-repeat: no-repeat; mask-position: 100% 100%; }`, body: BOX },
  { name: 'font-variation-settings', before: '.a { font-family: system-ui; }', after: '.a { font-family: system-ui; font-variation-settings: "wght" 800; }', body: P },
  { name: 'font-stretch', before: '.a { font-family: system-ui; }', after: '.a { font-family: system-ui; font-stretch: 75%; }', body: P },
  { name: 'font-kerning', before: '.a { font-kerning: normal; }', after: '.a { font-kerning: none; }', body: '<p class="a" style="width:300px;height:40px;margin:0;font-size:40px">AVAVAV</p>' },
  { name: 'text-decoration-thickness', before: '.a { text-decoration: underline; }', after: '.a { text-decoration: underline; text-decoration-thickness: 6px; }', body: P },
  { name: 'text-underline-offset', before: '.a { text-decoration: underline; }', after: '.a { text-decoration: underline; text-underline-offset: 8px; }', body: P },
  { name: 'text-decoration-skip-ink', before: '.a { text-decoration: underline; }', after: '.a { text-decoration: underline; text-decoration-skip-ink: none; }', body: '<p class="a" style="width:300px;height:40px;margin:0;font-size:30px">gypsy</p>' },
  { name: 'text-emphasis', before: '.a { }', after: '.a { text-emphasis: filled circle red; }', body: P },
  { name: 'text-overflow', before: '.a { white-space: nowrap; overflow: hidden; width: 60px; }', after: '.a { white-space: nowrap; overflow: hidden; width: 60px; text-overflow: ellipsis; }', body: '<p class="a" style="margin:0">Text in a very long line</p>' },
  { name: 'word-break', before: '.a { width: 60px; height: 100px; overflow: hidden; }', after: '.a { width: 60px; height: 100px; overflow: hidden; word-break: break-all; }', body: '<p class="a" style="margin:0">Texttexttexttexttext</p>' },
  { name: 'hyphens', before: '.a { width: 60px; height: 100px; overflow: hidden; }', after: '.a { width: 60px; height: 100px; overflow: hidden; hyphens: auto; }', body: '<p class="a" lang="en" style="margin:0">internationalization</p>' },
  { name: 'text-overflow on the parent of the text', before: '.a { width: 60px; overflow: hidden; white-space: nowrap; }', after: '.a { width: 60px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }', body: '<p class="a" style="margin:0"><span>Text in a long line</span></p>' },
  { name: 'text-wrap balance', before: '.a { width: 200px; height: 100px; }', after: '.a { width: 200px; height: 100px; text-wrap: balance; }', body: '<p class="a" style="margin:0">one two three four five six seven eight nine</p>' },
  { name: 'tab-size', before: '.a { white-space: pre; }', after: '.a { white-space: pre; tab-size: 20; }', body: '<p class="a" style="margin:0;width:300px;height:40px">a\tb</p>' },
  { name: 'list-style-image', before: '.a { list-style-image: none; }', after: `.a { list-style-image: ${GRAD}; }`, body: LIST },
  { name: 'list-style-position', before: '.a { list-style-position: outside; }', after: '.a { list-style-position: inside; }', body: LIST },
  { name: 'marker content', before: '.a::marker { content: "A "; }', after: '.a::marker { content: "B "; }', body: LIST },
  { name: 'marker background-free font', before: '.a::marker { color: red; }', after: '.a::marker { color: red; unicode-bidi: bidi-override; direction: rtl; content: "xy "; }', body: LIST },
  { name: 'placeholder background', before: '.a::placeholder { background: white; }', after: '.a::placeholder { background: red; }', body: FIELD },
  { name: 'placeholder text-decoration', before: '.a::placeholder { text-decoration: none; }', after: '.a::placeholder { text-decoration: underline; }', body: FIELD },
  { name: 'ol start attribute', before: '', after: '', beforeBody: '<ol start="1" style="margin:0 0 0 40px;padding:0"><li>Text</li></ol>', body: '<ol start="5" style="margin:0 0 0 40px;padding:0"><li>Text</li></ol>' },
  { name: 'li value attribute', before: '', after: '', beforeBody: '<ol style="margin:0 0 0 40px;padding:0"><li value="1">Text</li></ol>', body: '<ol style="margin:0 0 0 40px;padding:0"><li value="7">Text</li></ol>' },
  { name: 'ol reversed attribute', before: '', after: '', beforeBody: '<ol style="margin:0 0 0 40px;padding:0"><li>A</li><li>B</li></ol>', body: '<ol reversed style="margin:0 0 0 40px;padding:0"><li>A</li><li>B</li></ol>' },
  { name: 'column-rule', before: '.a { column-count: 2; }', after: '.a { column-count: 2; column-rule: 4px solid red; }', body: '<p class="a" style="width:300px;height:80px;margin:0">one two three four five six seven eight nine ten eleven twelve thirteen</p>' },
  { name: 'column-count fixed box', before: '.a { }', after: '.a { column-count: 2; }', body: '<p class="a" style="width:300px;height:80px;margin:0">one two three four five six seven eight nine ten eleven twelve thirteen</p>' },
  { motion: true, name: 'animation removed, same first frame', before: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { animation: k 1s infinite; }', after: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { }', body: P },
  { motion: true, name: 'animation-duration', before: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { animation: k 1s forwards; }', after: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { animation: k 9s forwards; }', body: P },
  { name: 'counter-reset value via ::before', before: '.a { counter-reset: n 1; } .a::before { counter-increment: n; content: counter(n); }', after: '.a { counter-reset: n 7; } .a::before { counter-increment: n; content: counter(n); }', body: '<div class="a" style="width:100px;height:40px"></div>' },
  { name: 'attr() content via data attribute', before: '.a { position: relative; } .a::before { content: attr(data-label); position: absolute; }', after: '.a { position: relative; } .a::before { content: attr(data-label); position: absolute; }', beforeBody: '<div class="a" data-label="A" style="width:100px;height:40px"></div>', body: '<div class="a" data-label="B" style="width:100px;height:40px"></div>' },
  { name: 'quotes on q', before: 'q { quotes: "<" ">"; }', after: 'q { quotes: "[" "]"; }', body: '<p style="width:300px;height:40px;margin:0"><q>Text</q></p>' },
  { name: 'color-scheme dark on root', before: ':root { color-scheme: light; }', after: ':root { color-scheme: dark; }', body: '<div style="color:black">x</div>' },
  { name: 'isolation', before: '.a { isolation: auto; } .b { mix-blend-mode: difference; }', after: '.a { isolation: isolate; } .b { mix-blend-mode: difference; }', body: '<div style="background:rgb(0,200,0)"><div class="a"><div class="b" style="width:100px;height:40px;background:rgb(200,0,0)"></div></div></div>' },
  { name: 'perspective', before: '.a { } .b { transform: rotateY(45deg); }', after: '.a { perspective: 100px; } .b { transform: rotateY(45deg); }', body: '<div class="a" style="width:200px;height:100px"><div class="b" style="width:100px;height:80px;background:red"></div></div>' },
  { name: 'backface-visibility', before: '.a { transform: rotateY(180deg); }', after: '.a { transform: rotateY(180deg); backface-visibility: hidden; }', body: '<div class="a" style="width:100px;height:80px;background:red"></div>' },
  { name: 'empty-cells', before: 'td { border: 2px solid red; }', after: 'td { border: 2px solid red; empty-cells: hide; }', body: '<table style="border-collapse:separate"><tr><td style="width:40px;height:40px"></td><td style="width:40px">x</td></tr></table>' },
  { name: 'svg fill-rule', before: 'path { fill-rule: nonzero; }', after: 'path { fill-rule: evenodd; }', body: '<svg width="100" height="100" viewBox="0 0 100 100"><path fill="red" d="M10 10H90V90H10Z M30 30H70V70H30Z"></path></svg>' },
  { name: 'svg paint-order', before: 'text { stroke: blue; stroke-width: 6px; }', after: 'text { stroke: blue; stroke-width: 6px; paint-order: stroke; }', body: '<svg width="200" height="60"><text x="5" y="40" font-size="40" fill="red">Text</text></svg>' },
  { name: 'svg stroke-miterlimit', before: 'path { stroke: red; stroke-width: 10px; fill: none; stroke-miterlimit: 10; }', after: 'path { stroke: red; stroke-width: 10px; fill: none; stroke-miterlimit: 1; }', body: '<svg width="100" height="100"><path d="M10 90 L50 10 L90 90"></path></svg>' },
  { name: 'svg marker-end', before: '', after: 'path { marker-end: url(#m); }', body: '<svg width="100" height="100"><defs><marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2"><circle cx="2" cy="2" r="2" fill="red"></circle></marker></defs><path d="M10 50 L80 50" stroke="blue" stroke-width="4"></path></svg>' },
  { name: 'svg currentColor via color on parent', before: 'svg { color: red; }', after: 'svg { color: blue; }', body: '<svg width="100" height="100"><rect width="50" height="50" fill="currentColor"></rect></svg>' },
  { name: 'element goes display none, other element recolors', before: '.b { color: black; }', after: '.a { display: none; } .b { color: red; }', body: '<div class="a" style="height:60px;background:red;width:100px;position:absolute;left:150px;top:100px"></div><p class="b" style="margin:0;width:100px">Text</p>' },
  { name: 'box moves, outline only at new place', before: '.a { position: absolute; left: 0; top: 0; }', after: '.a { position: absolute; left: 200px; top: 150px; }', body: '<div class="a" style="width:40px;height:40px;background:red"></div>' },
  { name: 'box shrinks', before: '.a { width: 300px; height: 200px; background: red; }', after: '.a { width: 40px; height: 40px; background: red; }', body: '<div class="a"></div>' },
  { name: 'iframe srcdoc', before: '', after: '', beforeBody: '<iframe srcdoc="<p>one</p>" width="200" height="100"></iframe>', body: '<iframe srcdoc="<p>two</p>" width="200" height="100"></iframe>' },
  { name: 'text moved past inline child, same text', before: '', after: '', beforeBody: '<p style="margin:0">ab<i></i>cd ef</p>', body: '<p style="margin:0">ab<i></i>ef cd</p>' },
  { name: 'text order across child, same concat', before: '', after: '', beforeBody: '<p style="margin:0">ab <b>x</b> cd</p>', body: '<p style="margin:0">ab cd <b>x</b> </p>' },
  { name: 'details open marker no content', before: '', after: '', beforeBody: '<details><summary>Text</summary></details>', body: '<details open><summary>Text</summary></details>' },
  { name: 'vertical-align on text span no box change', before: 'b { vertical-align: baseline; }', after: 'b { vertical-align: 10px; }', body: '<p style="margin:0;height:60px;line-height:60px"><b>x</b> y</p>' },
  { name: 'text-align-last', before: '.a { }', after: '.a { text-align-last: right; }', body: P },
  { name: 'unicode-bidi', before: '.a { direction: rtl; }', after: '.a { direction: rtl; unicode-bidi: bidi-override; }', body: P },
  { name: 'filter on ::before via attr', before: '.a::before { content: ""; display:block; width:40px; height:40px; background: red; border-image: none; }', after: `.a::before { content: ""; display:block; width:40px; height:40px; background: red; border: 5px solid; border-image: ${GRAD} 1; box-sizing: border-box; }`, body: BOX },
  { name: 'border-radius on an img', before: '.a { border-radius: 0; }', after: '.a { border-radius: 40px; }', body: IMG },
  { name: 'border-radius with backdrop-filter', before: '.a { position:absolute; inset:0 auto auto 0; width:120px; height:120px; backdrop-filter: invert(1); border-radius: 0; }', after: '.a { position:absolute; inset:0 auto auto 0; width:120px; height:120px; backdrop-filter: invert(1); border-radius: 60px; }', body: '<div style="width:200px;height:200px;background:rgb(0,200,0)"></div><div class="a"></div>' },
  { name: 'border-radius on a child-clipping filter-free svg', before: 'svg { border-radius: 0; }', after: 'svg { border-radius: 40px; }', body: '<svg width="120" height="120"><rect width="120" height="120" fill="red"></rect></svg>' },
  { name: 'content-visibility hidden', before: '.a { height: 80px; }', after: '.a { height: 80px; content-visibility: hidden; }', body: '<div class="a">Text in here</div>' },
  { name: 'contain paint', before: '.a { width: 40px; height: 40px; }', after: '.a { width: 40px; height: 40px; contain: paint; }', body: '<div class="a"><div style="width:200px;height:20px;background:red"></div></div>' },
  { motion: true, name: 'animation-fill-mode', before: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { animation: k 1ms forwards; }', after: '@keyframes k { from { opacity: 1; } to { opacity: 0.2; } } .a { animation: k 1ms none; }', body: '<p class="a">Text</p>' }
];
