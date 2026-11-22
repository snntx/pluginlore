// Edge visual styling by relationship type. Kept separate from analyze.js so the
// UI bundle doesn't have to include the PHP/JS parsers just to draw lines.
export const EDGE_STYLE = {
  include:    { style: 'solid',   color: '#4f7cff', label: 'includes' },
  extends:    { style: 'dashed',  color: '#9b59e8', label: 'extends' },
  implements: { style: 'dotted',  color: '#1fab89', label: 'implements' },
  'use-trait':{ style: 'dashdot', color: '#e07b39', label: 'uses trait' },
  call:       { style: 'solid',   color: '#8a8f98', label: 'calls' },
  hook:       { style: 'dashed',  color: '#3fb950', label: 'hooks' },
  ajax:       { style: 'solid',   color: '#d6336c', label: 'JS → AJAX' },
  'rest-call':{ style: 'solid',   color: '#2d79c7', label: 'JS → REST' },
  enqueue:    { style: 'dotted',  color: '#b08a3e', label: 'enqueues' },
  dom:        { style: 'dashdot', color: '#0ea5a5', label: 'JS ↔ DOM' },
};
