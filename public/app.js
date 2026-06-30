/**
 * Logica del frontend:
 *   1. Subir el .xlsx (POST /api/upload) -> recibe un jobId
 *   2. Hacer polling de GET /api/jobs/:id cada segundo
 *   3. Pintar los pasos del pipeline y las barras de progreso
 */

const form = document.getElementById('upload-form');
const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzone-text');
const submitBtn = document.getElementById('submit-btn');
const statusCard = document.getElementById('status-card');
const stepsEl = document.getElementById('steps');
const jobMeta = document.getElementById('job-meta');
const jobResult = document.getElementById('job-result');
const jobsBody = document.getElementById('jobs-body');
const overallFill = document.getElementById('overall-fill');
const overallLabel = document.getElementById('overall-label');
const jobWarnings = document.getElementById('job-warnings');
const jobError = document.getElementById('job-error');

let pollTimer = null;

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.innerHTML = busy
    ? '<span class="btn-spinner"></span> Procesando...'
    : 'Subir y actualizar índice';
  dropzone.classList.toggle('disabled', busy);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------- seleccion de archivo

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    dropzoneText.innerHTML = `Archivo seleccionado: <strong>${fileInput.files[0].name}</strong>`;
    submitBtn.disabled = false;
  }
});

['dragover', 'dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.toggle('dragging', evt === 'dragover');
  })
);

dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.xlsx')) {
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change'));
  } else {
    dropzoneText.textContent = 'Solo se aceptan archivos .xlsx';
  }
});

// ---------------------------------------------------------------- subida

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (fileInput.files.length === 0) return;

  const data = new FormData();
  data.append('archivo', fileInput.files[0]);
  data.append('namespace', document.getElementById('namespace').value);

  setBusy(true);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: data });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    watchJob(body.jobId);
  } catch (err) {
    setBusy(false);
    statusCard.classList.remove('hidden');
    jobError.classList.remove('hidden');
    jobError.innerHTML =
      `<strong>No se pudo iniciar la carga</strong><p>${escapeHtml(err.message)}</p>` +
      `<p class="hint">Verifica que el archivo sea un .xlsx menor a 25 MB y que el servidor esté activo.</p>`;
  }
});

// ---------------------------------------------------------------- polling y render

function watchJob(jobId) {
  statusCard.classList.remove('hidden');
  jobResult.textContent = '';
  jobWarnings.classList.add('hidden');
  jobError.classList.add('hidden');
  clearInterval(pollTimer);

  const poll = async () => {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) return;
    const job = await res.json();
    renderJob(job);
    if (job.status !== 'en_proceso') {
      clearInterval(pollTimer);
      setBusy(false);
      refreshJobsList();
    }
  };

  poll();
  pollTimer = setInterval(poll, 1000);
}

const STATUS_ICONS = {
  pendiente: '○',
  completado: '●',
  error: '✕',
};

/** Avance global: pasos completados + fraccion del paso en curso, sobre el total. */
function overallProgress(job) {
  let done = 0;
  for (const step of job.steps) {
    if (step.status === 'completado') done += 1;
    else if (step.status === 'en_progreso' && step.progress?.total > 0) {
      done += step.progress.done / step.progress.total;
    }
  }
  return Math.round((done / job.steps.length) * 100);
}

function renderJob(job) {
  jobMeta.textContent = `${job.filename} → namespace "${job.namespace}"`;

  // Barra de avance global
  const pctGlobal = job.status === 'completado' ? 100 : overallProgress(job);
  overallFill.style.width = `${pctGlobal}%`;
  overallFill.classList.toggle('fail', job.status === 'error');
  overallLabel.textContent = job.status === 'error' ? 'detenido' : `${pctGlobal}%`;

  // Pasos
  stepsEl.innerHTML = job.steps.map(step => {
    const pct = step.progress && step.progress.total > 0
      ? Math.round((step.progress.done / step.progress.total) * 100)
      : null;
    const icon = step.status === 'en_progreso'
      ? '<span class="spinner"></span>'
      : STATUS_ICONS[step.status];
    return `
      <li class="step ${step.status}">
        <span class="step-icon">${icon}</span>
        <div class="step-body">
          <span class="step-label">${escapeHtml(step.label)}</span>
          ${step.detail ? `<span class="step-detail">${escapeHtml(step.detail)}</span>` : ''}
          ${pct !== null && step.status === 'en_progreso'
            ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
               <span class="step-detail">${step.progress.done} / ${step.progress.total} (${pct}%)</span>`
            : ''}
        </div>
      </li>`;
  }).join('');

  // Avisos no fatales: que parte del Excel NO se indexo y por que
  if (job.warnings && job.warnings.length > 0) {
    jobWarnings.classList.remove('hidden');
    jobWarnings.innerHTML =
      '<strong>Avisos</strong><ul>' +
      job.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') +
      '</ul>';
  }

  // Resultado final
  if (job.status === 'completado') {
    jobResult.textContent = '✔ Índice actualizado correctamente.';
    jobResult.className = 'job-result ok';
  } else if (job.status === 'error') {
    jobResult.textContent = '';
    jobError.classList.remove('hidden');
    jobError.innerHTML =
      `<strong>La carga se detuvo</strong>` +
      `<p>${escapeHtml(job.error)}</p>` +
      (job.errorHint ? `<p class="hint">💡 ${escapeHtml(job.errorHint)}</p>` : '');
  }
}

// ---------------------------------------------------------------- historial

async function refreshJobsList() {
  const res = await fetch('/api/jobs');
  if (!res.ok) return;
  const jobs = await res.json();
  if (jobs.length === 0) return;

  jobsBody.innerHTML = jobs.map(j => `
    <tr>
      <td>${escapeHtml(j.filename)}</td>
      <td>${escapeHtml(j.namespace)}</td>
      <td>
        <span class="badge ${j.status}">${j.status.replace('_', ' ')}</span>
        ${j.warnings > 0 ? `<span class="badge warn" title="${j.warnings} aviso(s)">⚠ ${j.warnings}</span>` : ''}
      </td>
      <td>${new Date(j.createdAt).toLocaleString()}</td>
    </tr>`).join('');
}

refreshJobsList();
