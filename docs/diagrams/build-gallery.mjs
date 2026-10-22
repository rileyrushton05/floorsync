/** Build the diagram catalogue and lightweight local viewer from committed image exports. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const items = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const sourceName = item => item.renderer === 'drawio' ? 'draw.io' : 'Mermaid';
const sections = [];
let markdown = `# FloorSync system diagrams

${items.length} diagrams cover the system architecture, backend components, reliability and playback patterns, data model and key runtime flows. Final PNG images are embedded in the relevant documentation; SVG exports and editable sources are kept alongside this catalogue.

[Open the local image viewer](index.html). It loads the committed image files and works offline when this directory is kept together.

## Organisation

| Folder | Contents |
| --- | --- |
| [architecture/](architecture/) | Supplied system architecture and backend component images. |
| [patterns/](patterns/) | Transactional outbox and event-sourced playback images. |
| [data/](data/) | Production/account and schedule/simulation ERDs, plus the existing detailed schema references. |
| [sequences/](sequences/) | Schedule-generation and simulation/live-update sequences. |
| [sources/](sources/) | Editable draw.io and Mermaid files. |

The supplied system architecture image is preserved unchanged. Component and pattern views describe the inspected backend implementation in more detail.

## Diagram index

| Diagram | Used in | Editable source |
| --- | --- | --- |
`;
for (const item of items) {
  const documents = item.documents.map(document => `[${document.title}](${document.path})`).join(', ');
  markdown += `| [${item.title}](#${item.id}) | ${documents} | ${item.source === item.image ? 'Supplied PNG' : `[${sourceName(item)}](${item.source})`} |\n`;
}
markdown += '\n';
for (const item of items) {
  for (const file of new Set([item.image, item.source, item.vector].filter(Boolean))) {
    await fs.access(path.join(dir, file));
  }
  const exports = [`[PNG](${item.image})`];
  if (item.vector) exports.push(`[SVG](${item.vector})`);
  if (item.source !== item.image) exports.push(`[Editable ${sourceName(item)} source](${item.source})`);
  const decision = item.decision ? `Decision: [${item.decision_title}](${item.decision}).\n\n` : '';
  markdown += `<a id="${item.id}"></a>\n\n## ${item.title}\n\n${item.description}\n\n${decision}![${item.title}](${item.image})\n\n${exports.join(' · ')}\n\n`;
  const editable = item.renderer === 'drawio'
    ? `<a href="${escape(item.source)}" target="_blank" rel="noopener">View draw.io source</a>` : '';
  sections.push(`<section id="${escape(item.id)}"><div class="heading"><div><span>${escape(item.kind)}</span><h2>${escape(item.title)}</h2></div><div class="actions"><button data-action="fit">Fit</button><button data-action="actual">Actual size</button><a href="${escape(item.image)}" target="_blank" rel="noopener">Open PNG</a>${editable}</div></div><p>${escape(item.description)}</p>${item.decision ? `<p><a href="${escape(item.decision)}">${escape(item.decision_title)}</a></p>` : ''}<div class="canvas"><img class="diagram" src="${escape(item.image)}" alt="${escape(item.title)}"></div></section>`);
}
markdown += "## Detailed schema references\n\nThe earlier [physical schema](data/physical-schema.png) and [schedule-storage design](data/schedule-storage-design.png) are retained as supporting references in the data folder. The two focused ERDs above are the overview views used in the documentation.\n\n## Maintenance\n\nEdit draw.io files in `sources/` and export the corresponding PNG and SVG into the diagram's category folder. Edit Mermaid files in `sources/` and regenerate their PNG/SVG exports. Keep the PNGs committed so Markdown viewers do not need a diagram renderer. The supplied architecture is available as a PNG only.\n\n`manifest.json` records the image, source, related documents and decision links. After adding, renaming or exporting diagrams, rebuild the catalogue and viewer from the repository root:\n\n```sh\nnode docs/diagrams/build-gallery.mjs\n```\n\nThe builder uses only Node.js built-ins and references the existing exports; it does not redraw them or embed duplicate image data in HTML.\n";
await fs.writeFile(path.join(dir, 'README.md'), markdown);
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FloorSync · System diagrams</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:#203347;background:#f4f6f8;font:15px/1.55 system-ui,sans-serif}aside{position:fixed;inset:0 auto 0 0;width:245px;padding:32px 22px;background:white;border-right:1px solid #dde3e9;overflow:auto}aside strong{font-size:24px}aside p{color:#68798a;font-size:13px}nav a{display:block;padding:10px 0;color:#285d88;text-decoration:none;font-size:14px}main{margin-left:245px;padding:36px;max-width:1800px}h1{font-size:30px;margin:0 0 10px}.intro{color:#627486;margin-bottom:30px}section{background:white;border:1px solid #dde3e9;padding:25px;margin-bottom:28px;scroll-margin-top:20px}.heading{display:flex;justify-content:space-between;gap:18px;align-items:center}.heading span{font-size:12px;color:#647b90;text-transform:uppercase;letter-spacing:1px}h2{font-size:22px;margin:3px 0}section p{color:#647486;max-width:1050px;font-size:14px}.actions{display:flex;gap:7px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}button,.actions a{font:inherit;font-size:13px;color:#285d88;border:1px solid #cdd9e3;border-radius:4px;background:white;padding:7px 10px;cursor:pointer;text-decoration:none}.canvas{overflow:auto;padding:15px;background:white;border-top:1px solid #e6ebef}.diagram{display:block;width:100%;height:auto}.diagram.actual{width:auto;max-width:none}@media(max-width:900px){aside{position:static;width:auto}nav{display:flex;gap:20px;flex-wrap:wrap}main{margin:0;padding:18px}.heading{display:block}.actions{margin-top:12px;justify-content:flex-start}section{padding:15px}}@media print{aside,.actions{display:none}main{margin:0;padding:0}section{break-before:page;border:0}.canvas{overflow:visible}.diagram.actual{width:100%}}
</style></head><body><aside><strong>FloorSync</strong><p>System diagrams<br>${items.length} essential views</p><nav>${items.map(item => `<a href="#${escape(item.id)}">${escape(item.title)}</a>`).join('')}</nav></aside><main><h1>System diagrams</h1><p class="intro">Architecture, backend components, architectural patterns, data and the two key runtime flows. Select Actual size to inspect a diagram, or open the final image.</p>${sections.join('')}</main><script>document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>button.closest('section').querySelector('img').classList.toggle('actual',button.dataset.action==='actual')));</script></body></html>`);
console.log(`Built catalogue and viewer for ${items.length} diagrams.`);
