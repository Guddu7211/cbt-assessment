/**
 * Employee Assessment CBT System
 * Node.js + Express + PostgreSQL (Railway / Render / Supabase compatible)
 */

const express  = require('express');
const { Pool } = require('pg');
const multer   = require('multer');
const xlsx     = require('xlsx');
const csv      = require('csv-parser');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');
const crypto   = require('crypto');
const { Readable } = require('stream');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static('.'));

const upload = multer({ storage: multer.memoryStorage() });

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// Railway / Render inject DATABASE_URL automatically.
// For Supabase use the "Connection pooling" URI (port 5432).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ─── DB INIT ─────────────────────────────────────────────────────────────────
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS questions (
      id          SERIAL PRIMARY KEY,
      question    TEXT NOT NULL,
      "optionA"   TEXT,
      "optionB"   TEXT,
      "optionC"   TEXT,
      "optionD"   TEXT,
      answer      VARCHAR(2),
      explanation TEXT,
      "timeLimit" INT DEFAULT 0,
      locked      BOOLEAN DEFAULT false
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id     SERIAL PRIMARY KEY,
      name   VARCHAR(255) NOT NULL,
      "empId" VARCHAR(100) NOT NULL UNIQUE,
      email  VARCHAR(255) NOT NULL UNIQUE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS results (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(255),
      "empId"             VARCHAR(100),
      email               VARCHAR(255),
      score               INT DEFAULT 0,
      percentage          NUMERIC(5,2) DEFAULT 0,
      "timeTaken"         INT DEFAULT 0,
      "answersJSON"       TEXT DEFAULT '{}',
      "questionIdsJSON"   TEXT DEFAULT '[]',
      status              VARCHAR(20) DEFAULT 'in-progress',
      "startTime"         TIMESTAMPTZ DEFAULT NOW(),
      "endTime"           TIMESTAMPTZ,
      "currentQuestion"   INT DEFAULT 0,
      "timeRemainingTotal" INT DEFAULT 0,
      "tabSwitches"       INT DEFAULT 0,
      "extraTimeSeconds"  INT DEFAULT 0
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS exam_settings (
      id                        INT DEFAULT 1 PRIMARY KEY,
      "totalTime"               INT DEFAULT 3600,
      "perQuestionTime"         INT DEFAULT 0,
      "examStatus"              VARCHAR(20) DEFAULT 'stopped',
      "maxQuestionsPerCandidate" INT DEFAULT 40,
      "shuffleQuestions"        BOOLEAN DEFAULT true,
      "shuffleOptions"          BOOLEAN DEFAULT true,
      "tabSwitchLimit"          INT DEFAULT 3
    )
  `);

  const settingsCheck = await query(`SELECT COUNT(*) as cnt FROM exam_settings`);
  if (parseInt(settingsCheck.rows[0].cnt) === 0) {
    await query(`INSERT INTO exam_settings VALUES (1, 3600, 0, 'stopped', 40, true, true, 3)`);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS review_passwords (
      id          SERIAL PRIMARY KEY,
      password    VARCHAR(10),
      "createdAt" TIMESTAMPTZ DEFAULT NOW(),
      "validUntil" TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          SERIAL PRIMARY KEY,
      action      VARCHAR(500),
      "adminUser" VARCHAR(255),
      "targetUser" VARCHAR(255),
      details     TEXT,
      timestamp   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('✅ Database tables ready');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function auditLog(action, adminUser, targetUser, details = '') {
  try {
    await query(
      `INSERT INTO audit_logs (action, "adminUser", "targetUser", details) VALUES ($1,$2,$3,$4)`,
      [action, adminUser || 'system', targetUser || '', details]
    );
  } catch (e) { /* non-fatal */ }
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toRows(res) { return res.rows; }
function toRow(res)  { return res.rows[0]; }

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
let ADMIN_KEY_LIVE = process.env.ADMIN_KEY || 'admin123';

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY_LIVE) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═════════════════════════════════════════════════════════════════════════════
// CANDIDATE APIS
// ═════════════════════════════════════════════════════════════════════════════

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { empId, email } = req.body;
    if (!empId || !email) return res.status(400).json({ error: 'EmpID and email required' });

    const cand = toRow(await query(
      `SELECT * FROM candidates WHERE "empId" = $1 AND email = $2`,
      [empId, email]
    ));
    if (!cand) return res.status(401).json({ error: 'Invalid Employee ID or Email. Please contact HR.' });

    const s = toRow(await query(`SELECT * FROM exam_settings WHERE id = 1`));

    const existing = toRow(await query(
      `SELECT * FROM results WHERE "empId" = $1 ORDER BY id DESC LIMIT 1`,
      [empId]
    ));

    if (existing) {
      if (existing.status === 'completed') {
        const qIds = JSON.parse(existing.questionIdsJSON || '[]');
        return res.json({
          status: 'completed', candidate: cand,
          result: {
            score: existing.score,
            percentage: existing.percentage,
            timeTaken: existing.timeTaken,
            totalQuestions: qIds.length,
            endTime: existing.endTime,
          },
        });
      }
      if (existing.status === 'in-progress') {
        if (s.examStatus !== 'started')
          return res.json({ status: 'exam-stopped', candidate: cand });

        return res.json({
          status: 'resume',
          candidate: cand,
          resultId: existing.id,
          currentQuestion: existing.currentQuestion || 0,
          questionIds: JSON.parse(existing.questionIdsJSON || '[]'),
          answers: JSON.parse(existing.answersJSON || '{}'),
          timeRemaining: existing.timeRemainingTotal || s.totalTime,
          totalTime: s.totalTime + (existing.extraTimeSeconds || 0),
          perQuestionTime: s.perQuestionTime,
        });
      }
    }

    if (s.examStatus !== 'started')
      return res.json({ status: 'exam-stopped', candidate: cand });

    // Select random questions
    const allQs = toRows(await query(`SELECT id FROM questions WHERE locked = false`));
    const allIds = allQs.map(q => q.id);
    const maxQ   = Math.min(parseInt(s.maxQuestionsPerCandidate), allIds.length);
    const selectedIds = (s.shuffleQuestions ? shuffleArray(allIds) : allIds).slice(0, maxQ);

    const inserted = toRow(await query(
      `INSERT INTO results (name, "empId", email, "questionIdsJSON", "answersJSON", status, "timeRemainingTotal")
       VALUES ($1,$2,$3,$4,'{}','in-progress',$5) RETURNING id`,
      [cand.name, cand.empId, cand.email, JSON.stringify(selectedIds), s.totalTime]
    ));

    await auditLog('EXAM_STARTED', 'system', cand.empId, `${maxQ} questions selected`);

    return res.json({
      status: 'new', candidate: cand,
      resultId: inserted.id,
      currentQuestion: 0,
      questionIds: selectedIds,
      answers: {},
      timeRemaining: s.totalTime,
      totalTime: s.totalTime,
      perQuestionTime: s.perQuestionTime,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET QUESTION
app.get('/api/question/:resultId/:index', async (req, res) => {
  try {
    const { resultId, index } = req.params;
    const result = toRow(await query(`SELECT * FROM results WHERE id = $1`, [resultId]));
    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (result.status === 'completed') return res.status(400).json({ error: 'Exam already completed' });

    const questionIds = JSON.parse(result.questionIdsJSON || '[]');
    const idx = parseInt(index);
    if (idx < 0 || idx >= questionIds.length) return res.status(400).json({ error: 'Invalid index' });

    const q = toRow(await query(`SELECT * FROM questions WHERE id = $1`, [questionIds[idx]]));
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const s = toRow(await query(`SELECT "shuffleOptions" FROM exam_settings WHERE id = 1`));
    let options = [
      { key: 'A', text: q.optionA },
      { key: 'B', text: q.optionB },
      { key: 'C', text: q.optionC },
      { key: 'D', text: q.optionD },
    ];
    if (s.shuffleOptions) options = shuffleArray(options);

    return res.json({
      id: q.id, question: q.question, options,
      timeLimit: q.timeLimit, total: questionIds.length, current: idx,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SUBMIT ANSWER
app.post('/api/answer', async (req, res) => {
  try {
    const { resultId, questionIndex, selectedOption, timeSpent } = req.body;
    const result = toRow(await query(`SELECT * FROM results WHERE id = $1`, [resultId]));
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    const questionIds = JSON.parse(result.questionIdsJSON || '[]');
    const answers     = JSON.parse(result.answersJSON || '{}');
    const qId         = questionIds[questionIndex];

    const q = toRow(await query(`SELECT answer, explanation FROM questions WHERE id = $1`, [qId]));
    const isCorrect = selectedOption === q.answer;

    answers[questionIndex] = {
      questionId: qId, selected: selectedOption,
      correct: q.answer, isCorrect, timeSpent: timeSpent || 0,
    };

    await query(
      `UPDATE results SET "answersJSON" = $1, "currentQuestion" = $2 WHERE id = $3`,
      [JSON.stringify(answers), parseInt(questionIndex) + 1, resultId]
    );

    return res.json({ isCorrect, correctAnswer: q.answer, explanation: q.explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SAVE TIMER
app.post('/api/save-timer', async (req, res) => {
  try {
    const { resultId, timeRemaining, tabSwitches } = req.body;
    await query(
      `UPDATE results SET "timeRemainingTotal" = $1, "tabSwitches" = $2 WHERE id = $3`,
      [timeRemaining, tabSwitches || 0, resultId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUBMIT EXAM
app.post('/api/submit', async (req, res) => {
  try {
    const { resultId, timeTaken } = req.body;
    const result = toRow(await query(`SELECT * FROM results WHERE id = $1`, [resultId]));
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.status === 'completed') return res.json({ alreadyCompleted: true, score: result.score, percentage: result.percentage });

    const answers     = JSON.parse(result.answersJSON || '{}');
    const questionIds = JSON.parse(result.questionIdsJSON || '[]');
    let score = 0;
    for (const key of Object.keys(answers)) { if (answers[key].isCorrect) score++; }
    const percentage = questionIds.length > 0 ? ((score / questionIds.length) * 100).toFixed(2) : 0;

    await query(
      `UPDATE results SET score=$1, percentage=$2, "timeTaken"=$3, status='completed', "endTime"=NOW(), "timeRemainingTotal"=0 WHERE id=$4`,
      [score, percentage, timeTaken || 0, resultId]
    );
    await auditLog('EXAM_SUBMITTED', 'system', result.empId, `Score: ${score}/${questionIds.length}`);
    return res.json({ score, percentage, total: questionIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TAB SWITCH
app.post('/api/tab-switch', async (req, res) => {
  try {
    const { resultId } = req.body;
    await query(`UPDATE results SET "tabSwitches" = COALESCE("tabSwitches",0)+1 WHERE id=$1`, [resultId]);
    const r = toRow(await query(`SELECT "tabSwitches" FROM results WHERE id=$1`, [resultId]));
    const s = toRow(await query(`SELECT "tabSwitchLimit" FROM exam_settings WHERE id=1`));
    res.json({ tabSwitches: r.tabSwitches, autoSubmit: r.tabSwitches >= (s.tabSwitchLimit || 3) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REVIEW (password-protected)
app.post('/api/review', async (req, res) => {
  try {
    const { empId, password } = req.body;
    const pw = toRow(await query(
      `SELECT * FROM review_passwords WHERE password=$1 AND ("validUntil" IS NULL OR "validUntil" > NOW())`,
      [password]
    ));
    if (!pw) return res.status(401).json({ error: 'Invalid or expired review password' });

    const result = toRow(await query(
      `SELECT * FROM results WHERE "empId"=$1 AND status='completed' ORDER BY id DESC LIMIT 1`,
      [empId]
    ));
    if (!result) return res.status(404).json({ error: 'No completed exam found' });

    const answers     = JSON.parse(result.answersJSON || '{}');
    const questionIds = JSON.parse(result.questionIdsJSON || '[]');
    const review = [];

    for (let i = 0; i < questionIds.length; i++) {
      const q = toRow(await query(`SELECT * FROM questions WHERE id=$1`, [questionIds[i]]));
      if (q) {
        const ans = answers[i] || {};
        review.push({
          index: i + 1, question: q.question,
          options: { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD },
          correctAnswer: q.answer,
          selectedAnswer: ans.selected || 'Not answered',
          isCorrect: ans.isCorrect || false,
          explanation: q.explanation,
        });
      }
    }
    res.json({ review, score: result.score, percentage: result.percentage, timeTaken: result.timeTaken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUBLIC SETTINGS
app.get('/api/settings', async (req, res) => {
  try {
    res.json(toRow(await query(`SELECT * FROM exam_settings WHERE id=1`)) || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN APIS
// ═════════════════════════════════════════════════════════════════════════════

// GET SETTINGS
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(toRow(await query(`SELECT * FROM exam_settings WHERE id=1`)) || {}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE SETTINGS
app.post('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { totalTime, perQuestionTime, examStatus, maxQuestionsPerCandidate, shuffleQuestions, shuffleOptions, tabSwitchLimit } = req.body;
    await query(
      `UPDATE exam_settings SET "totalTime"=$1,"perQuestionTime"=$2,"examStatus"=$3,"maxQuestionsPerCandidate"=$4,"shuffleQuestions"=$5,"shuffleOptions"=$6,"tabSwitchLimit"=$7 WHERE id=1`,
      [totalTime, perQuestionTime, examStatus, maxQuestionsPerCandidate, !!shuffleQuestions, !!shuffleOptions, tabSwitchLimit]
    );
    await auditLog('SETTINGS_UPDATED', 'admin', '', JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXAM CONTROL
app.post('/api/admin/exam-control', adminAuth, async (req, res) => {
  try {
    const status = req.body.action === 'start' ? 'started' : 'stopped';
    await query(`UPDATE exam_settings SET "examStatus"=$1 WHERE id=1`, [status]);
    await auditLog(`EXAM_${req.body.action.toUpperCase()}`, 'admin', '');
    res.json({ ok: true, examStatus: status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// QUESTIONS CRUD
app.get('/api/admin/questions', adminAuth, async (req, res) => {
  try { res.json(toRows(await query(`SELECT * FROM questions ORDER BY id DESC`))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const { question, optionA, optionB, optionC, optionD, answer, explanation, timeLimit } = req.body;
    await query(
      `INSERT INTO questions (question,"optionA","optionB","optionC","optionD",answer,explanation,"timeLimit") VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [question, optionA, optionB, optionC, optionD, answer, explanation || '', timeLimit || 0]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { question, optionA, optionB, optionC, optionD, answer, explanation, timeLimit, locked } = req.body;
    await query(
      `UPDATE questions SET question=$1,"optionA"=$2,"optionB"=$3,"optionC"=$4,"optionD"=$5,answer=$6,explanation=$7,"timeLimit"=$8,locked=$9 WHERE id=$10`,
      [question, optionA, optionB, optionC, optionD, answer, explanation || '', timeLimit || 0, !!locked, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try { await query(`DELETE FROM questions WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/questions/:id/lock', adminAuth, async (req, res) => {
  try {
    await query(`UPDATE questions SET locked=$1 WHERE id=$2`, [!!req.body.locked, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPORT QUESTIONS
app.post('/api/admin/import-questions', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let rows = [];
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      rows = await new Promise((resolve, reject) => {
        const data = [];
        Readable.from(req.file.buffer.toString())
          .pipe(require('csv-parser')())
          .on('data', r => data.push(r))
          .on('end', () => resolve(data))
          .on('error', reject);
      });
    }

    let count = 0;
    for (const row of rows) {
      if (!row.question || !row.answer) continue;
      await query(
        `INSERT INTO questions (question,"optionA","optionB","optionC","optionD",answer,explanation,"timeLimit") VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.question, row.optionA||row.option_a||'', row.optionB||row.option_b||'', row.optionC||row.option_c||'', row.optionD||row.option_d||'',
         String(row.answer).trim(), row.explanation||'', parseInt(row.timeLimit||row.time_limit)||0]
      );
      count++;
    }
    await auditLog('QUESTIONS_IMPORTED', 'admin', '', `${count} questions`);
    res.json({ ok: true, count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORT QUESTIONS
app.get('/api/admin/export-questions', adminAuth, async (req, res) => {
  try {
    const rows = toRows(await query(`SELECT * FROM questions`));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Questions');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=questions.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CANDIDATES CRUD
app.get('/api/admin/candidates', adminAuth, async (req, res) => {
  try { res.json(toRows(await query(`SELECT * FROM candidates ORDER BY id DESC`))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/candidates', adminAuth, async (req, res) => {
  try {
    const { name, empId, email } = req.body;
    await query(`INSERT INTO candidates (name,"empId",email) VALUES($1,$2,$3)`, [name, empId, email]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Employee ID or Email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/candidates/:id', adminAuth, async (req, res) => {
  try { await query(`DELETE FROM candidates WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPORT CANDIDATES
app.post('/api/admin/import-candidates', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let rows = [];
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      rows = await new Promise((resolve, reject) => {
        const data = [];
        Readable.from(req.file.buffer.toString())
          .pipe(require('csv-parser')())
          .on('data', r => data.push(r))
          .on('end', () => resolve(data))
          .on('error', reject);
      });
    }

    let count = 0;
    for (const row of rows) {
      if (!row.empId || !row.email) continue;
      try {
        await query(
          `INSERT INTO candidates (name,"empId",email) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [row.name || '', String(row.empId), row.email]
        );
        count++;
      } catch (e) { /* skip duplicates */ }
    }
    await auditLog('CANDIDATES_IMPORTED', 'admin', '', `${count} candidates`);
    res.json({ ok: true, count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORT CANDIDATES
app.get('/api/admin/export-candidates', adminAuth, async (req, res) => {
  try {
    const rows = toRows(await query(`SELECT * FROM candidates`));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Candidates');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=candidates.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RESULTS
app.get('/api/admin/results', adminAuth, async (req, res) => {
  try { res.json(toRows(await query(`SELECT * FROM results ORDER BY id DESC`))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// LIVE DASHBOARD
app.get('/api/admin/live', adminAuth, async (req, res) => {
  try {
    const rows = toRows(await query(`
      SELECT id, name, "empId", email, status, "currentQuestion",
             "timeRemainingTotal", "tabSwitches", "startTime",
             jsonb_array_length("questionIdsJSON"::jsonb) AS "totalQuestions"
      FROM results ORDER BY "startTime" DESC
    `));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RESET CANDIDATE
app.post('/api/admin/reset-candidate', adminAuth, async (req, res) => {
  try {
    await query(`DELETE FROM results WHERE "empId"=$1`, [req.body.empId]);
    await auditLog('CANDIDATE_RESET', 'admin', req.body.empId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FORCE SUBMIT
app.post('/api/admin/force-submit', adminAuth, async (req, res) => {
  try {
    const result = toRow(await query(`SELECT * FROM results WHERE id=$1`, [req.body.resultId]));
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.status === 'completed') return res.json({ ok: true, score: result.score, percentage: result.percentage });

    const answers     = JSON.parse(result.answersJSON || '{}');
    const questionIds = JSON.parse(result.questionIdsJSON || '[]');
    let score = 0;
    for (const k of Object.keys(answers)) { if (answers[k].isCorrect) score++; }
    const percentage = questionIds.length > 0 ? ((score / questionIds.length) * 100).toFixed(2) : 0;

    await query(
      `UPDATE results SET score=$1, percentage=$2, status='completed', "endTime"=NOW() WHERE id=$3`,
      [score, percentage, req.body.resultId]
    );
    await auditLog('FORCE_SUBMITTED', 'admin', result.empId, `Score: ${score}/${questionIds.length}`);
    res.json({ ok: true, score, percentage });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXTEND TIME
app.post('/api/admin/extend-time', adminAuth, async (req, res) => {
  try {
    const { resultId, seconds } = req.body;
    const r = toRow(await query(`SELECT "empId" FROM results WHERE id=$1`, [resultId]));
    await query(
      `UPDATE results SET "extraTimeSeconds"=COALESCE("extraTimeSeconds",0)+$1, "timeRemainingTotal"=COALESCE("timeRemainingTotal",0)+$1 WHERE id=$2`,
      [seconds, resultId]
    );
    await auditLog('TIME_EXTENDED', 'admin', r?.empId, `${seconds} seconds`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REVIEW PASSWORD
app.post('/api/admin/review-password', adminAuth, async (req, res) => {
  try {
    const pwd = crypto.randomInt(100000, 999999).toString();
    let validUntil = null;
    if (req.body.validHours) {
      const d = new Date(); d.setHours(d.getHours() + parseInt(req.body.validHours));
      validUntil = d.toISOString();
    }
    await query(`INSERT INTO review_passwords (password,"validUntil") VALUES($1,$2)`, [pwd, validUntil]);
    await auditLog('REVIEW_PASSWORD_GENERATED', 'admin', '');
    res.json({ password: pwd });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/review-passwords', adminAuth, async (req, res) => {
  try { res.json(toRows(await query(`SELECT * FROM review_passwords ORDER BY "createdAt" DESC`))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// AUDIT LOGS
app.get('/api/admin/audit-logs', adminAuth, async (req, res) => {
  try { res.json(toRows(await query(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 500`))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// CLEAR DATA
app.post('/api/admin/clear', adminAuth, async (req, res) => {
  try {
    const { target } = req.body;
    if (target === 'questions')  await query(`DELETE FROM questions`);
    if (target === 'candidates') await query(`DELETE FROM candidates`);
    if (target === 'results')    await query(`DELETE FROM results`);
    if (target === 'all') {
      await query(`DELETE FROM questions`);
      await query(`DELETE FROM candidates`);
      await query(`DELETE FROM results`);
    }
    await auditLog(`CLEAR_${target.toUpperCase()}`, 'admin', '');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ANALYTICS
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const [cands, qns, comp, prog, avg, top, s] = await Promise.all([
      query(`SELECT COUNT(*) as cnt FROM candidates`),
      query(`SELECT COUNT(*) as cnt FROM questions`),
      query(`SELECT COUNT(*) as cnt FROM results WHERE status='completed'`),
      query(`SELECT COUNT(*) as cnt FROM results WHERE status='in-progress'`),
      query(`SELECT AVG(percentage) as avg FROM results WHERE status='completed'`),
      query(`SELECT name,"empId",score,percentage,"timeTaken" FROM results WHERE status='completed' ORDER BY percentage DESC,"timeTaken" ASC LIMIT 10`),
      query(`SELECT "examStatus" FROM exam_settings WHERE id=1`),
    ]);
    res.json({
      totalCandidates: parseInt(cands.rows[0].cnt),
      totalQuestions:  parseInt(qns.rows[0].cnt),
      completed:       parseInt(comp.rows[0].cnt),
      inProgress:      parseInt(prog.rows[0].cnt),
      avgScore:        parseFloat(avg.rows[0].avg || 0).toFixed(1),
      topPerformers:   top.rows,
      examStatus:      s.rows[0]?.examStatus,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORT RESULTS
app.get('/api/admin/export-results', adminAuth, async (req, res) => {
  try {
    const rows = toRows(await query(`SELECT id,name,"empId",email,score,percentage,"timeTaken",status,"startTime","endTime","tabSwitches" FROM results ORDER BY id DESC`));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Results');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=results.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DB HEALTH
app.get('/api/admin/db-status', adminAuth, async (req, res) => {
  try {
    await query(`SELECT 1`);
    const [q, c, r] = await Promise.all([
      query(`SELECT COUNT(*) as cnt FROM questions`),
      query(`SELECT COUNT(*) as cnt FROM candidates`),
      query(`SELECT COUNT(*) as cnt FROM results`),
    ]);
    res.json({ status: 'healthy', questions: parseInt(q.rows[0].cnt), candidates: parseInt(c.rows[0].cnt), results: parseInt(r.rows[0].cnt) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// CHANGE ADMIN KEY
app.post('/api/admin/change-key', async (req, res) => {
  const current = req.headers['x-admin-key'];
  if (current !== ADMIN_KEY_LIVE) return res.status(401).json({ error: 'Current admin key is incorrect.' });
  const { newKey } = req.body;
  if (!newKey || newKey.trim().length < 6) return res.status(400).json({ error: 'New key must be at least 6 characters.' });
  ADMIN_KEY_LIVE = newKey.trim();
  await auditLog('ADMIN_KEY_CHANGED', 'admin', '');
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`🔑 Admin Key : ${ADMIN_KEY_LIVE}`);
    });
  })
  .catch(err => {
    console.error('❌ DB init failed:', err.message);
    process.exit(1);
  });
