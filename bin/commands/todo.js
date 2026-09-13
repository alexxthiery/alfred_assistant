// commands/todo.js — `wiki todo` task/reminder control plane. Todos are
// ordinary type:todo pages; a remind_at makes one a timed reminder (the morning
// brief surfaces it on its due date, the dispatcher fires the push). All task
// creation, update, classification, and lifecycle changes go through this file
// so the assistant never needs to hand-edit todo markdown.

'use strict';

const fs = require('fs');
const { WIKI_DIR, nowISO, wikiPath, forEachPage } = require('../lib/vault.js');
const { serializeFrontmatter } = require('../lib/frontmatter.js');
const { isISODate } = require('../lib/date.js');
const { validateExtraFieldValue } = require('../lib/maintenance.js');
const { readPageForWrite, regenerateIndex, appendLog } = require('../lib/page-io.js');
const { validateForWrite, validateBody } = require('../lib/write-validate.js');

const TODO_STATUSES = new Set(['open', 'doing', 'done', 'abandoned']);
const TODO_PRIORITIES = new Set(['high', 'med', 'low']);

function cmdTodo(args) {
  const sub = args._[0];
  const subArgs = { ...args, _: args._.slice(1) };
  const subs = {
    add: todoAdd,
    list: todoList,
    update: todoUpdate,
    classify: todoClassify,
    done: todoDone,
    reopen: todoReopen,
    abandon: todoAbandon,
    defer: todoDefer,
  };
  if (!sub || !subs[sub]) {
    console.error('Usage: wiki todo <add|list|update|classify|done|reopen|abandon|defer> ...');
    process.exit(1);
  }
  subs[sub](subArgs);
}

function todoSlugify(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `todo-${base || 'untitled'}`;
}

function splitCsv(raw) {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizePriority(raw) {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === 'medium') return 'med';
  return v;
}

function normalizeStatus(raw) {
  if (raw === undefined || raw === null || raw === false) return undefined;
  return String(raw).trim().toLowerCase();
}

function validatePriority(raw, flag = '--priority') {
  const v = normalizePriority(raw);
  if (!TODO_PRIORITIES.has(v)) {
    console.error(`error: ${flag} must be high|med|low (got "${raw}")`);
    process.exit(3);
  }
  return v;
}

function validateStatus(raw, flag = '--status') {
  const v = normalizeStatus(raw);
  if (!TODO_STATUSES.has(v)) {
    console.error(`error: ${flag} must be open|doing|done|abandoned (got "${raw}")`);
    process.exit(3);
  }
  return v;
}

function validateDue(raw, flag = '--due') {
  const v = String(raw);
  if (!isISODate(v)) {
    console.error(`error: ${flag} must be YYYY-MM-DD (got "${raw}")`);
    process.exit(3);
  }
  return v;
}

function validateReminder(raw, flag = '--remind_at') {
  const { value, error } = validateExtraFieldValue('remind_at', raw);
  if (error) {
    console.error(`error: ${error.replace('--remind_at', flag)}`);
    process.exit(3);
  }
  return value;
}

function validateNotify(raw) {
  const values = splitCsv(raw);
  const known = new Set(['telegram', 'email']);
  const unknown = values.filter((v) => !known.has(v));
  if (unknown.length) {
    console.error(`error: --notify must contain only telegram,email (got "${raw}")`);
    process.exit(3);
  }
  return values;
}

function validateTagsForTodo(slug, title, tags, body = '', args = {}) {
  const writeErrors = validateForWrite({ slug, type: 'todo', tags }, { isAppend: false });
  if (writeErrors.length) {
    console.error(`error: strict todo validation failed for ${slug}:`);
    for (const e of writeErrors) console.error(`  ${e}`);
    process.exit(3);
  }
  if (args.soft) return;
  const bodyErrors = validateBody({ slug, title, type: 'todo', tags, body, fm: { id: slug, title, type: 'todo', tags, status: 'open' } });
  if (bodyErrors.length) {
    console.error(`error: strict todo validation failed for ${slug}:`);
    for (const e of bodyErrors) {
      console.error(`  [${e.rule}] ${e.message}`);
      if (e.fix) console.error(`    -> fix: ${e.fix}`);
    }
    console.error('  (If this is truly an action, use an action-shaped title or pass --soft intentionally.)');
    process.exit(3);
  }
}

function validateTodoPage(slug, fm, body, args = {}) {
  const writeErrors = validateForWrite({
    slug,
    type: fm.type,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    derivedFrom: fm.derived_from,
  }, { isAppend: false });
  const bodyErrors = args.soft ? [] : validateBody({
    slug,
    title: fm.title || slug,
    type: fm.type,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    body,
    fm,
  });
  if (!writeErrors.length && !bodyErrors.length) return;
  console.error(`error: strict todo validation failed for ${slug}:`);
  for (const e of writeErrors) console.error(`  ${e}`);
  for (const e of bodyErrors) {
    console.error(`  [${e.rule}] ${e.message}`);
    if (e.fix) console.error(`    -> fix: ${e.fix}`);
  }
  process.exit(3);
}

function loadTodoForWrite(slug) {
  if (!slug) {
    console.error('error: missing todo slug');
    process.exit(1);
  }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) {
    console.error(`error: todo ${slug} not found`);
    process.exit(2);
  }
  const parsed = readPageForWrite(p);
  if (parsed.fm.type !== 'todo') {
    console.error(`error: page ${slug} is not a todo (type=${parsed.fm.type})`);
    process.exit(2);
  }
  return { p, fm: parsed.fm, body: parsed.body };
}

function writeTodoPage(p, slug, fm, body, op, detail) {
  fm.updated = nowISO();
  fs.writeFileSync(p, serializeFrontmatter(fm, body));
  regenerateIndex();
  appendLog(op, detail || slug);
}

function setTodoStatus(fm, status) {
  fm.status = status;
  const ts = nowISO();
  if (status === 'done') {
    fm.done_at = ts;
    delete fm.abandoned_at;
  } else if (status === 'abandoned') {
    fm.abandoned_at = ts;
    delete fm.done_at;
  } else {
    delete fm.done_at;
    delete fm.abandoned_at;
  }
}

function applyTodoUpdate(fm, args, { classifyOnly = false } = {}) {
  const changed = [];

  if (!classifyOnly && args.title !== undefined && args.title !== false) {
    const title = String(args.title).trim();
    if (!title) { console.error('error: --title cannot be empty'); process.exit(3); }
    fm.title = title;
    changed.push('title');
  }

  if (!classifyOnly && args.status !== undefined && args.status !== false) {
    setTodoStatus(fm, validateStatus(args.status));
    changed.push('status');
  }

  if (!classifyOnly && args.due !== undefined && args.due !== false) {
    fm.due = validateDue(args.due);
    changed.push('due');
  }
  if (!classifyOnly && args['clear-due']) {
    delete fm.due;
    changed.push('due');
  }

  if (args.priority !== undefined && args.priority !== false) {
    fm.priority = validatePriority(args.priority);
    changed.push('priority');
  }
  if (args['clear-priority']) {
    delete fm.priority;
    changed.push('priority');
  }

  if (args.tags !== undefined && args.tags !== false) {
    fm.tags = splitCsv(args.tags);
    changed.push('tags');
  }
  if (args['add-tag'] !== undefined && args['add-tag'] !== false) {
    const tags = new Set(Array.isArray(fm.tags) ? fm.tags : []);
    for (const t of splitCsv(args['add-tag'])) tags.add(t);
    fm.tags = [...tags].sort();
    changed.push('tags');
  }
  if (args['remove-tag'] !== undefined && args['remove-tag'] !== false) {
    const drop = new Set(splitCsv(args['remove-tag']));
    fm.tags = (Array.isArray(fm.tags) ? fm.tags : []).filter((t) => !drop.has(t));
    changed.push('tags');
  }
  if (args['clear-tags']) {
    fm.tags = [];
    changed.push('tags');
  }

  if (!classifyOnly && args.remind_at !== undefined && args.remind_at !== false) {
    fm.remind_at = validateReminder(args.remind_at);
    if (!fm.notify) fm.notify = ['telegram', 'email'];
    changed.push('remind_at');
  }
  if (!classifyOnly && args.notify !== undefined && args.notify !== false) {
    fm.notify = validateNotify(args.notify);
    changed.push('notify');
  }
  if (!classifyOnly && args['clear-remind']) {
    delete fm.remind_at;
    delete fm.reminded_at;
    delete fm.notify;
    changed.push('remind_at');
  }

  return [...new Set(changed)];
}

function todoAdd(args) {
  const title = args._[0];
  if (!title) { console.error('Usage: wiki todo add "title" [--due ...] [--priority ...] [--remind_at ISO] [--notify telegram,email]'); process.exit(1); }
  const baseSlug = todoSlugify(title);
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(wikiPath(slug))) { slug = `${baseSlug}-${n}`; n++; }
  const tags = args.tags ? splitCsv(args.tags) : [];
  const fm = {
    id: slug, title, type: 'todo',
    created: nowISO(), updated: nowISO(), tags,
    status: 'open',
  };
  if (args.due) fm.due = validateDue(args.due);
  if (args.priority) fm.priority = validatePriority(args.priority);
  // Reminder fields: a todo with remind_at is a timed reminder. The dispatcher
  // (bin/reminder-dispatch) fires the Telegram push at remind_at; the morning
  // brief surfaces it on its due date. notify defaults to both channels and is
  // only meaningful alongside remind_at.
  if (args.remind_at !== undefined && args.remind_at !== false) {
    fm.remind_at = validateReminder(args.remind_at);
    fm.notify = args.notify
      ? validateNotify(args.notify)
      : ['telegram', 'email'];
  } else if (args.notify) {
    fm.notify = validateNotify(args.notify);
  }
  validateTagsForTodo(slug, title, tags, '', args);
  if (!args.soft) {
    const bodyErrors = validateBody({ slug, title: fm.title, type: fm.type, tags: fm.tags, body: '', fm });
    if (bodyErrors.length) {
      console.error(`error: strict todo validation failed for ${slug}:`);
      for (const e of bodyErrors) {
        console.error(`  [${e.rule}] ${e.message}`);
        if (e.fix) console.error(`    -> fix: ${e.fix}`);
      }
      console.error('  (If this is truly an action, use an action-shaped title or pass --soft intentionally.)');
      process.exit(3);
    }
  }
  if (args['dry-run']) {
    console.log(wikiPath(slug));
    console.log('(dry-run: no writes)');
    return;
  }
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  fs.writeFileSync(wikiPath(slug), serializeFrontmatter(fm, '\n'));
  regenerateIndex();
  appendLog('todo:add', slug);
  console.log(wikiPath(slug));
}

function todoList(args) {
  // --asof YYYY-MM-DD overrides "today" for --overdue/--due-today, so callers
  // (e.g. bin/daily-brief --date) get deterministic classification independent
  // of the wall clock. Defaults to the real today.
  let today = nowISO().slice(0, 10);
  if (args.asof !== undefined) {
    if (!isISODate(String(args.asof))) {
      console.error(`error: --asof must be YYYY-MM-DD (got "${args.asof}")`);
      process.exit(1);
    }
    today = String(args.asof);
  }
  const rows = [];
  forEachPage(({ slug: fileSlug, fm }) => {
    if (fm.type !== 'todo') return;
    const status = fm.status || 'open';
    if (args.open && status !== 'open') return;
    if (args.done && status !== 'done') return;
    if (args.status && status !== String(args.status)) return;
    // --overdue / --due-today are ACTIONABLE views (they drive the morning
    // brief): only OPEN todos belong. Without this a done/retired todo with a
    // past or today due date leaked into the brief as "overdue" — the exact
    // bug reported. Requiring open also auto-excludes any future retired/
    // cancelled status, not just done.
    if ((args.overdue || args['due-today']) && status !== 'open') return;
    if (args['due-today'] && fm.due !== today) return;
    if (args.overdue && (!fm.due || fm.due >= today)) return;
    if (args.background && status !== 'open') return;
    if (args.background && fm.due && fm.due <= today) return;
    if (args.reminders && !fm.remind_at) return;
    if (args.tag) {
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      if (!tags.includes(String(args.tag))) return;
    }
    if (args.priority && normalizePriority(fm.priority) !== normalizePriority(args.priority)) return;
    const slug = fm.id || fileSlug;
    rows.push({
      slug, title: fm.title || '', status, due: fm.due || '', priority: fm.priority || '',
      remind_at: fm.remind_at || '', reminded_at: fm.reminded_at || '',
      notify: Array.isArray(fm.notify) ? fm.notify.join(',') : (fm.notify || ''),
      tags: Array.isArray(fm.tags) ? fm.tags : [],
    });
  });
  const prio = { high: 0, med: 1, medium: 1, low: 2 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.due !== b.due) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
    return (prio[a.priority] ?? 3) - (prio[b.priority] ?? 3);
  });
  if (args.json) {
    console.log(JSON.stringify(rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      status: r.status,
      due: r.due || null,
      priority: r.priority || null,
      remind_at: r.remind_at || null,
      reminded_at: r.reminded_at || null,
      notify: r.notify ? r.notify.split(',').filter(Boolean) : [],
      tags: r.tags,
    })), null, 2));
    return;
  }
  if (rows.length === 0) { console.log('(no matching todos)'); return; }
  for (const r of rows) {
    const dueStr = r.due ? `due ${r.due}` : '';
    const pStr = r.priority ? `[${r.priority}]` : '';
    // Columns 5+ are reminder metadata, appended (never reordered) so the
    // index-based parser in bin/lib/daily-brief.js still reads cols 0-4.
    // bin/lib/reminder-dispatch.js parses these trailing columns by prefix.
    const remindStr = r.remind_at ? `remind ${r.remind_at}` : '';
    const remindedStr = r.reminded_at ? `reminded ${r.reminded_at}` : '';
    const notifyStr = r.notify ? `notify ${r.notify}` : '';
    console.log(`${r.status}\t${r.slug}\t${r.title}\t${dueStr}\t${pStr}\t${remindStr}\t${remindedStr}\t${notifyStr}`);
  }
}

function todoUpdate(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki todo update <slug> [--title "..."] [--status open|doing|done|abandoned] [--due YYYY-MM-DD|--clear-due] [--priority high|med|low|--clear-priority] [--tags a,b|--add-tag t|--remove-tag t] [--remind_at ISO|--clear-remind] [--notify telegram,email]');
    process.exit(1);
  }
  const { p, fm, body } = loadTodoForWrite(slug);
  const changed = applyTodoUpdate(fm, args);
  if (!changed.length) {
    console.error('error: no todo fields changed');
    process.exit(1);
  }
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:update', `${slug} (${changed.join(',')})`);
  console.log(`updated: ${slug} (${changed.join(', ')})`);
}

function todoClassify(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki todo classify <slug> [--tags a,b|--add-tag t|--remove-tag t|--clear-tags] [--priority high|med|low|--clear-priority]');
    process.exit(1);
  }
  const { p, fm, body } = loadTodoForWrite(slug);
  const changed = applyTodoUpdate(fm, args, { classifyOnly: true });
  if (!changed.length) {
    console.error('error: no classification fields changed');
    process.exit(1);
  }
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:classify', `${slug} (${changed.join(',')})`);
  console.log(`classified: ${slug} (${changed.join(', ')})`);
}

function todoDone(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki todo done <slug>'); process.exit(1); }
  const { p, fm, body } = loadTodoForWrite(slug);
  setTodoStatus(fm, 'done');
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:done', slug);
  console.log(`done: ${slug}`);
}

function todoReopen(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki todo reopen <slug>'); process.exit(1); }
  const { p, fm, body } = loadTodoForWrite(slug);
  setTodoStatus(fm, 'open');
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:reopen', slug);
  console.log(`reopened: ${slug}`);
}

function todoAbandon(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki todo abandon <slug>'); process.exit(1); }
  const { p, fm, body } = loadTodoForWrite(slug);
  setTodoStatus(fm, 'abandoned');
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:abandon', slug);
  console.log(`abandoned: ${slug}`);
}

function todoDefer(args) {
  const slug = args._[0];
  if (!slug || !args.to) { console.error('Usage: wiki todo defer <slug> --to YYYY-MM-DD'); process.exit(1); }
  const to = validateDue(args.to, '--to');
  const { p, fm, body } = loadTodoForWrite(slug);
  const oldDue = fm.due || '(none)';
  fm.due = to;
  validateTodoPage(slug, fm, body, args);
  writeTodoPage(p, slug, fm, body, 'todo:defer', `${slug} (${oldDue} -> ${to})`);
  console.log(`deferred: ${slug} -> ${to}`);
}

module.exports = { cmdTodo };
