import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'node:fs';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const pick = (v) => (Array.isArray(v) ? v[0] : v);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let fields, files;
  try {
    const form = formidable({
      maxFileSize: 20 * 1024 * 1024,
      multiples: true,
      allowEmptyFiles: true,
      minFileSize: 0,
    });
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
  const projectFiles = (files.project_files
    ? (Array.isArray(files.project_files) ? files.project_files : [files.project_files])
    : []
  ).filter((f) => f && f.size > 0);

  if (!name || !email || !position || !video_url || !cv) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = (name) => {
    const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  };

  const cvPath = `${stamp}-${rand}/cv.${ext(cv.originalFilename)}`;
  const cvBuffer = fs.readFileSync(cv.filepath);
  const { error: cvErr } = await supabase.storage
    .from('cvs')
    .upload(cvPath, cvBuffer, { contentType: cv.mimetype || 'application/octet-stream', upsert: false });
  if (cvErr) {
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    console.error(
      'CV upload error:', cvErr,
      'path:', cvPath,
      'urlHost:', new URL(SUPABASE_URL).host,
      'buckets visible to this key:', buckets?.map(b => b.name) || `LIST FAILED: ${listErr?.message}`
    );
    return res.status(500).json({
      error: `CV upload failed: ${cvErr.message}`,
      debug: {
        path: cvPath,
        statusCode: cvErr.statusCode,
        urlHost: new URL(SUPABASE_URL).host,
        buckets: buckets?.map(b => b.name) || null,
        listError: listErr?.message || null,
      }
    });
  }

  const projectPaths = [];
  for (const [i, f] of projectFiles.entries()) {
    const path = `${stamp}-${rand}/project-${i}.${ext(f.originalFilename)}`;
    const buf = fs.readFileSync(f.filepath);
    const { error } = await supabase.storage
      .from('cvs')
      .upload(path, buf, { contentType: f.mimetype || 'application/octet-stream', upsert: false });
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
