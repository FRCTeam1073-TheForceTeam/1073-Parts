// Add/edit dialog for custom (made in-house) parts.
import {
  h, fill, api, toast, attempt, state, PRIORITIES, openModal, closeModal, refresh, render, field,
  isMentor, processList, photoPicker,
} from './core.js';
import { openViewer, isViewable, renderThumbnail } from './viewer.js';
import { stageOf, taskCounts } from './board.js';

const canDeleteCustom = (p) => isMentor() || p.created_by === state.user.id;
const FILE_ACCEPT = '.step,.stp,.stl,.3mf,.obj,.dxf,.dwg,.gcode,.bgcode,.f3d,.sldprt,.pdf';
export const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Files section: attach STEP/STL/3MF/etc. Uploads happen right away; new ones are linked to the part on save.
function filesSection(existing, onUploaded) {
  const files = [...(existing?.files || [])];
  const newIds = [];
  const input = h('input', { type: 'file', accept: FILE_ACCEPT, multiple: true, hidden: true });
  const list = h('div', { class: 'file-list' });
  const status = h('span', { class: 'part-sub' });
  const box = h('div', { class: 'files-box' });

  function draw() {
    fill(list, files.length ? files.map((f) => h('div', { class: 'file-row' },
      h('span', { class: 'file-ext' }, f.name.split('.').pop().toUpperCase()),
      h('a', { class: 'file-name', href: `/api/files/${f.id}`, download: f.name, title: 'Download' }, f.name),
      h('span', { class: 'part-sub' }, fileSize(f.size)),
      isViewable(f.name) ? h('button', { type: 'button', class: 'btn small', onclick: () => openViewer(f, existing) }, 'View 3D') : null,
      isMentor() || f.uploaded_by === state.user.id ? h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
        if (f.custom_part_id && !confirm(`Remove ${f.name}? This deletes it from the server.`)) return;
        const ok = await attempt(() => api('DELETE', `/api/files/${f.id}`));
        if (!ok) return;
        files.splice(files.indexOf(f), 1);
        if (newIds.includes(f.id)) newIds.splice(newIds.indexOf(f.id), 1);
        draw();
        if (f.custom_part_id) refresh();
      } }, 'Remove') : null)) : h('div', { class: 'part-sub' }, 'No files yet.'));
  }

  async function upload(fileList) {
    for (const file of fileList) {
      status.textContent = `Uploading ${file.name}…`;
      try {
        const res = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'That file is too large (over 100 MB).' : 'Upload failed'));
        files.push({ ...data, uploaded_by: state.user.id });
        newIds.push(data.id);
        draw();
        onUploaded?.(data);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    status.textContent = '';
  }

  input.addEventListener('change', () => {
    upload([...input.files]);
    input.value = '';
  });
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('over');
  });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    upload([...e.dataTransfer.files]);
  });

  fill(box,
    h('div', { class: 'files-head' },
      h('span', { class: 'part-sub' }, 'Drop STEP, STL, 3MF, DXF, G-code or PDF files here, so whoever makes it has the right file.'),
      h('button', { type: 'button', class: 'btn small', onclick: () => input.click() }, '+ Attach file')),
    list, status, input);
  draw();
  return { el: h('section', { class: 'cp-section' }, h('h3', {}, 'Files'), box), newIds };
}

// Tasks section: the part's checklist. On a saved part every change is sent right away (and the board behind
// the dialog updates); on a new part tasks are kept here and sent along when the part is created.
// Each stage (Design, Manufacturing, ...) has its own checklist. The dialog opens on the stage the part is in.
function tasksSection(existing, seed = {}) {
  const tasks = existing ? [...(existing.tasks || [])] : [];
  const cols = state.columns;
  const partStage = stageOf(existing || seed, cols);
  let shown = partStage;
  const stageBar = h('div', { class: 'seg task-stages', role: 'tablist', 'aria-label': 'Stage' });
  const list = h('div', { class: 'task-list' });
  const summary = h('span', { class: 'part-sub' });
  const canDelete = (t) => !existing || isMentor() || t.created_by === state.user.id || existing.created_by === state.user.id;
  const assigneeSelect = (value, onchange) => h('select', { class: 'task-who', 'aria-label': 'Assigned to', onchange },
    h('option', { value: '' }, 'Anyone'),
    state.team.map((u) => h('option', { value: u.id, selected: value === u.id }, u.display_name)));

  // Keep the part on the board in step with the checklist.
  function changed() {
    if (existing) {
      existing.tasks = tasks.slice();
      render();
    }
    draw();
  }

  async function update(t, patch) {
    if (!existing) {
      Object.assign(t, patch);
      return changed();
    }
    const saved = await attempt(() => api('PATCH', `/api/tasks/${t.id}`, patch));
    if (saved) Object.assign(t, saved);
    changed();
  }

  function draw() {
    const inStage = (id) => tasks.filter((t) => stageOf(t, cols) === id);
    fill(stageBar, cols.map((c) => {
      const n = taskCounts(inStage(c.id));
      return h('button', { type: 'button', role: 'tab', class: c.id === shown ? 'active' : '', 'aria-selected': String(c.id === shown),
        'aria-current': c.id === partStage ? 'step' : null, onclick: () => { shown = c.id; draw(); } },
        c.id === partStage ? '● ' : '', c.name, n.total ? h('span', { class: 'task-stage-n' + (n.left ? '' : ' all-done') }, ` ${n.done}/${n.total}`) : null);
    }));
    const visible = inStage(shown);
    const name = cols.find((c) => c.id === shown)?.name || 'this stage';
    const done = visible.filter((t) => t.done).length;
    summary.textContent = visible.length ? `${done} of ${visible.length} ${name} tasks done` : `No ${name} tasks yet.`;
    newText.placeholder = `Add a ${name} task, e.g. Cut plate, Tap 10-32 holes`;
    fill(list, visible.map((t) => {
      const text = h('input', { type: 'text', class: 'task-text' + (t.done ? ' done' : ''), value: t.text, 'aria-label': 'Task',
        onchange: (e) => (e.target.value.trim() ? update(t, { text: e.target.value }) : draw()) });
      return h('div', { class: 'task-row' },
        h('input', { type: 'checkbox', checked: !!t.done, 'aria-label': `Done: ${t.text}`, onchange: (e) => update(t, { done: e.target.checked }) }),
        text,
        assigneeSelect(t.assigned_to ?? null, (e) => update(t, { assigned_to: e.target.value ? Number(e.target.value) : null })),
        canDelete(t) ? h('button', { type: 'button', class: 'btn small icon', 'aria-label': `Delete task: ${t.text}`, title: 'Delete task', onclick: async () => {
          if (existing && !(await attempt(() => api('DELETE', `/api/tasks/${t.id}`)))) return;
          tasks.splice(tasks.indexOf(t), 1);
          changed();
        } }, '✕') : null);
    }));
  }

  const newText = h('input', { type: 'text', placeholder: 'Add a task, e.g. Cut plate, Tap 10-32 holes', 'aria-label': 'New task' });
  const newWho = assigneeSelect(null);
  async function add() {
    const text = newText.value.trim();
    if (!text) return newText.focus();
    const assigned_to = newWho.value ? Number(newWho.value) : null;
    const column_id = shown;
    if (existing) {
      const saved = await attempt(() => api('POST', `/api/custom-parts/${existing.id}/tasks`, { text, assigned_to, column_id }));
      if (!saved) return;
      tasks.push(saved);
    } else {
      tasks.push({ text, assigned_to, column_id, done: 0 });
    }
    newText.value = '';
    newWho.value = '';
    changed();
    newText.focus();
  }
  newText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });

  draw();
  return {
    el: h('section', { class: 'cp-section' }, h('h3', {}, 'Checklist'),
      h('div', { class: 'tasks-box' },
        cols.length > 1 ? stageBar : null, summary, list,
        h('div', { class: 'task-row task-add' }, newText, newWho, h('button', { type: 'button', class: 'btn small primary', onclick: add }, 'Add')))),
    // Tasks typed into a part that hasn't been saved yet.
    pending: () => (existing ? [] : tasks.map(({ text, assigned_to, column_id, done }) => ({ text, assigned_to, column_id, done: !!done }))),
  };
}

export function openCustomPartModal(existing = null, seed = {}) {
  const src = existing || seed;
  const personSelect = (value) => h('select', {}, h('option', { value: '' }, 'Nobody yet'),
    state.team.map((u) => h('option', { value: u.id, selected: value === u.id }, u.display_name)));

  const inputs = {
    name: h('input', { type: 'text', value: src.name || '', required: true, placeholder: 'e.g. Drivetrain side plate' }),
    part_number: h('input', { type: 'text', value: src.part_number || '', placeholder: 'e.g. 1073-DT-001' }),
    cad_url: h('input', { type: 'url', value: src.cad_url || '', placeholder: 'Onshape link' }),
    mechanism: h('select', {}, h('option', { value: '' }, 'Unassigned'),
      state.mechanisms.map((m) => h('option', { value: m.id, selected: src.mechanism_id === m.id }, m.name))),
    quantity: h('input', { type: 'number', min: 1, value: src.quantity ?? 1 }),
    quantity_done: h('input', { type: 'number', min: 0, value: src.quantity_done ?? 0 }),
    material: h('input', { type: 'text', value: src.material || '', placeholder: 'e.g. 1/4" 6061 plate, 1x2x1/16 tube, PLA' }),
    process: h('input', { type: 'text', list: 'process-list', value: src.process || '', placeholder: 'Pick or type' }),
    column: h('select', {}, state.columns.map((c, i) => h('option', { value: c.id, selected: src.column_id ? src.column_id === c.id : i === 0 }, c.name))),
    priority: h('select', {}, PRIORITIES.map((p) => h('option', { value: p, selected: (src.priority || 'normal') === p }, p[0].toUpperCase() + p.slice(1)))),
    assigned_to: personSelect(src.assigned_to),
    designer: personSelect(src.designer),
    due_date: h('input', { type: 'date', value: src.due_date || '' }),
    notes: h('textarea', { rows: 3, placeholder: 'Operations, tolerances, which face to tap…' }, src.notes || ''),
  };
  let image = src.image || null;
  const photo = photoPicker({ getUrl: () => image, setUrl: (url) => { image = url || null; }, label: 'Photo or drawing' });
  // When a 3D model is attached and the part has no photo yet, render one from the model.
  const checklist = tasksSection(existing, seed);
  const attachments = filesSection(existing, async (file) => {
    if (image || !isViewable(file.name)) return;
    photo.querySelector('.part-sub').textContent = `Rendering a picture of ${file.name}…`;
    try {
      image = await renderThumbnail(file);
    } catch (err) {
      toast(`Couldn't render ${file.name}: ${err.message}`, true);
    }
    photo.redraw();
  });
  const processes = h('datalist', { id: 'process-list' }, processList().map((p) => h('option', { value: p })));
  const openCad = h('a', { class: 'btn small', target: '_blank', rel: 'noopener', hidden: !src.cad_url, href: src.cad_url || '#' }, 'Open ↗');
  inputs.cad_url.addEventListener('input', () => {
    openCad.hidden = !/^https?:\/\//i.test(inputs.cad_url.value.trim());
    openCad.href = inputs.cad_url.value.trim();
  });

  // Layout: the work on the left (name, checklist, files, notes), the photo and the part's details in a sidebar on
  // the right, grouped by what you'd look for (status, people, how it's built). Stacks on narrow screens.
  inputs.name.classList.add('cp-name');
  const group = (title, ...fields) => h('section', { class: 'cp-group' }, h('h3', {}, title), ...fields);
  const body = h('div', { class: 'cp-layout' },
    h('div', { class: 'cp-main' },
      field('Part name', inputs.name, 'cp-name-field'),
      h('div', { class: 'cp-ref' },
        field('Part number', inputs.part_number),
        h('label', { class: 'field' }, h('span', {}, 'CAD link'), h('div', { class: 'inline' }, inputs.cad_url, openCad))),
      checklist.el,
      attachments.el,
      field('Notes', inputs.notes, 'cp-notes')),
    h('aside', { class: 'cp-side' },
      photo,
      group('Status',
        field('Stage', inputs.column),
        field('Priority', inputs.priority),
        field('Due date', inputs.due_date)),
      group('People',
        field('Making it', inputs.assigned_to),
        field('Designer', inputs.designer)),
      group('Build',
        field('Mechanism', inputs.mechanism),
        field('Process', inputs.process),
        field('Material / stock', inputs.material),
        field('Quantity needed', inputs.quantity),
        field('Quantity made', inputs.quantity_done))),
    processes);

  async function save() {
    const name = inputs.name.value.trim();
    if (!name) {
      inputs.name.focus();
      return toast('Part name is required', true);
    }
    const num = (el) => (el.value ? Number(el.value) : null);
    const data = {
      name,
      part_number: inputs.part_number.value.trim() || null,
      cad_url: inputs.cad_url.value.trim() || null,
      mechanism_id: num(inputs.mechanism),
      quantity: Math.max(1, Number(inputs.quantity.value) || 1),
      quantity_done: Math.max(0, Number(inputs.quantity_done.value) || 0),
      material: inputs.material.value.trim() || null,
      process: inputs.process.value.trim() || null,
      column_id: num(inputs.column),
      priority: inputs.priority.value,
      assigned_to: num(inputs.assigned_to),
      designer: num(inputs.designer),
      due_date: inputs.due_date.value || null,
      notes: inputs.notes.value.trim() || null,
      image,
      file_ids: attachments.newIds,
      ...(existing ? {} : { tasks: checklist.pending() }),
    };
    const ok = await attempt(() => (existing ? api('PATCH', `/api/custom-parts/${existing.id}`, data) : api('POST', '/api/custom-parts', data)),
      existing ? 'Saved' : 'Custom part added');
    if (!ok) return;
    closeModal();
    refresh();
  }

  openModal(existing ? 'Edit custom part' : 'Add custom part', body, [
    existing && canDeleteCustom(existing) ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
      if (!confirm(`Delete "${existing.name}"? This cannot be undone.`)) return;
      const ok = await attempt(() => api('DELETE', `/api/custom-parts/${existing.id}`), 'Part deleted');
      if (!ok) return;
      closeModal();
      refresh();
    } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: save }, existing ? 'Save' : 'Add part'),
  ], 'part-dialog');
  if (!existing) inputs.name.focus();
}
