import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'node:fs';
import nodemailer from 'nodemailer';

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

  // Send confirmation email — best-effort, never fails the request
  try {
    await sendConfirmationEmail({ name, email, position });
  } catch (err) {
    console.error('confirmation email failed:', err);
  }

  return res.status(200).json({ ok: true });
}

async function sendConfirmationEmail({ name, email, position }) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  console.log('email env check:', {
    hasUser: !!gmailUser,
    userLen: gmailUser?.length || 0,
    hasPass: !!gmailPass,
    passLen: gmailPass?.length || 0,
    sendingTo: email,
  });
  if (!gmailUser || !gmailPass) {
    console.warn('email skipped: GMAIL_USER or GMAIL_APP_PASSWORD not set in this environment');
    return;
  }

  const from = process.env.EMAIL_FROM || `Valu Internships <${gmailUser}>`;
  const firstName = (name || '').trim().split(/\s+/)[0] || 'there';
  const positionLabel = {
    coding: 'the Coding Internship',
    design: 'the UX/UI Design Internship',
    both: 'both internship tracks',
  }[position] || 'a Valu internship';

  const subject = `We've got your Valu application, ${firstName}`;

  const text = `Hi ${firstName},

Thanks for applying to ${positionLabel} at Valu — we've received your application and it's in our queue.

What happens next:
- We read every submission personally
- You'll hear back from us within two weeks, either way
- If we want to talk further, we'll email you to set up a short call

If anything's changed on your end (a new project link, a corrected CV), just reply to this email and we'll append it to your application.

Excited to meet you.

— The Valu Team
`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5FBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1A1F24;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5FBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:20px;border:1px solid #E6ECEE;overflow:hidden;">
        <tr><td style="padding:36px 40px 8px;">
          <div style="font-size:14px;color:#0A8FA6;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Valu Internships</div>
        </td></tr>
        <tr><td style="padding:8px 40px 24px;">
          <h1 style="font-size:26px;line-height:1.15;letter-spacing:-0.02em;margin:0 0 12px;font-weight:700;">We've got it, ${escapeHtml(firstName)}.</h1>
          <p style="margin:0;color:#4A555C;font-size:16px;line-height:1.55;">
            Thanks for applying to <strong style="color:#1A1F24;">${escapeHtml(positionLabel)}</strong> at Valu. Your application is in our queue and we'll be in touch within two weeks — either way.
          </p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;">
          <div style="background:#E4F6F9;border-left:3px solid #21BDD5;border-radius:0 12px 12px 0;padding:16px 20px;">
            <div style="font-size:12px;color:#0A8FA6;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">What happens next</div>
            <ul style="margin:0;padding-left:18px;color:#1A1F24;font-size:14.5px;line-height:1.55;">
              <li>We read every submission personally.</li>
              <li>You'll hear from us within two weeks.</li>
              <li>If we want to talk further, we'll email to set up a short call.</li>
            </ul>
          </div>
        </td></tr>
        <tr><td style="padding:0 40px 32px;">
          <p style="margin:0;color:#4A555C;font-size:14px;line-height:1.55;">
            Anything changed on your end — a new project link, a corrected CV? Just reply to this email and we'll append it to your application.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #E6ECEE;background:#F5FBFC;">
          <p style="margin:0;color:#8A9399;font-size:12px;line-height:1.5;">
            Excited to meet you.<br>— The Valu Team
          </p>
        </td></tr>
      </table>
      <div style="color:#8A9399;font-size:11px;margin-top:16px;">Valu · Own your identity, freedom, and security.</div>
    </td></tr>
  </table>
</body></html>`;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
  });

  await transporter.sendMail({ from, to: email, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
