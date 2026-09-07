import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'node:fs';

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const pick = (v) => (Array.isArray(v) ? v[0] : v);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let fields, files;
  try {
    const form = formidable({ maxFileSize: 20 * 1024 * 1024, multiples: true });
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse form: ${err.message}` });
  }

  const name       = pick(fields.name);
  const email      = pick(fields.email);
  const position   = pick(fields.position);
  const video_url  = pick(fields.video);
  const projects   = pick(fields.projects) || null;
  const cv         = pick(files.cv);
  const projectFiles = files.project_files
    ? (Array.isArray(files.project_files) ? files.project_files : [files.project_files])
    : [];

  if (!name || !email || !position || !video_url || !cv) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stamp = Date.now();
  const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

  const cvPath = `${stamp}/${safe(cv.originalFilename || 'cv')}`;
  const cvBuffer = fs.readFileSync(cv.filepath);
  const { error: cvErr } = await supabase.storage
    .from('cvs')
    .upload(cvPath, cvBuffer, { contentType: cv.mimetype, upsert: false });
  if (cvErr) return res.status(500).json({ error: `CV upload failed: ${cvErr.message}` });

  const projectPaths = [];
  for (const [i, f] of projectFiles.entries()) {
    const path = `${stamp}/projects/${i}-${safe(f.originalFilename || 'file')}`;
    const buf = fs.readFileSync(f.filepath);
    const { error } = await supabase.storage
      .from('cvs')
      .upload(path, buf, { contentType: f.mimetype, upsert: false });
    if (error) return res.status(500).json({ error: `Project file upload failed: ${error.message}` });
    projectPaths.push(path);
  }

  const { error: dbErr } = await supabase.from('applications').insert({
    name,
    email,
    position,
    video_url,
    projects,
    cv_path: cvPath,
    project_file_paths: projectPaths.length ? projectPaths : null,
  });
  if (dbErr) return res.status(500).json({ error: `DB insert failed: ${dbErr.message}` });

  return res.status(200).json({ ok: true });
}
