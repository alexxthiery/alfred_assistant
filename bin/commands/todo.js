// commands/todo.js — `wiki todo` {add,list,done,defer}. Todos are ordinary
// type:todo pages; a remind_at makes one a timed reminder (the morning brief
// surfaces it on its due date, the dispatcher fires the push). cmdTodo routes
// the subcommand; the todo* helpers do the work. fs side-effects via page-io.

'use strict';

const fs = require('fs');
const { WIKI_DIR, nowISO, wikiPath, forEachPage } = require('../lib/vault.js');
const { serializeFrontmatter } = require('../lib/frontmatter.js');
const { isISODate } = require('../lib/date.js');
const { validateExtraFieldValue } = require('../lib/maintenance.js');
const { readPageForWrite, regenerateIndex, appendLog } = require('../lib/page-io.js');
const { validateBody } = require('../lib/write-validate.js');

function cmdTodo(args) {
  const sub = args._[0];
  const subArgs = { ...args, _: args._.slice(1) };
  const subs = { add: todoAdd, list: todoList, done: todoDone, defer: todoDefer };
  if (!sub || !subs[sub]) {
    console.error('Usage: wiki todo <add|list|done|defer> ...');
    process.exit(1);
  }
  subs[sub](subArgs);
}

function todoSlugify(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `todo-${base || 'untitled'}`;
}

function todoAdd(args) {
  const title = args._[0];
  if (!title) { console.error('Usage: wiki todo add "title" [--due ...] [--priority ...] [--remind_at ISO] [--notify telegram,email]'); process.exit(1); }
  const baseSlug = todoSlugify(title);
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(wikiPath(slug))) { slug = `${baseSlug}-${n}`; n++; }
  const tags = args.tags ? String(args.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const fm = {
    id: slug, title, type: 'todo',
    created: nowISO(), updated: nowISO(), tags,
    status: 'open',
  };
  if (args.due) {
    const due = String(args.due);
    if (!isISODate(due)) {
      console.error(`error: --due must be YYYY-MM-DD (got "${args.due}")`);
      process.exit(3);
    }
    fm.due = due;
  }
  if (args.priority) fm.priority = args.priority;
  // Reminder fields: a todo with remind_at is a timed reminder. The dispatcher
  // (bin/reminder-dispatch) fires the Telegram push at remind_at; the morning
  // brief surfaces it on its due date. notify defaults to both channels and is
  // only meaningful alongside remind_at.
  if (args.remind_at !== undefined && args.remind_at !== false) {
    const { value, error } = validateExtraFieldValue('remind_at', args.remind_at);
    if (error) { console.error(`error: ${error}`); process.exit(3); }
    fm.remind_at = value;
    fm.notify = args.notify
      ? String(args.notify).split(',').map((s) => s.trim()).filter(Boolean)
      : ['telegram', 'email'];
  } else if (args.notify) {
    fm.notify = String(args.notify).split(',').map((s) => s.trim()).filter(Boolean);
  }
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
    // --overdue / --due-today are ACTIONABLE views (they drive the morning
    // brief): only OPEN todos belong. Without this a done/retired todo with a
    // past or today due date leaked into the brief as "overdue" — the exact
    // bug reported. Requiring open also auto-excludes any future retired/
    // cancelled status, not just done.
    if ((args.overdue || args['due-today']) && status !== 'open') return;
    if (args['due-today'] && fm.due !== today) return;
    if (args.overdue && (!fm.due || fm.due >= today)) return;
    if (args.reminders && !fm.remind_at) return;
    const slug = fm.id || fileSlug;
    rows.push({
      slug, title: fm.title || '', status, due: fm.due || '', priority: fm.priority || '',
      remind_at: fm.remind_at || '', reminded_at: fm.reminded_at || '',
      notify: Array.isArray(fm.notify) ? fm.notify.join(',') : (fm.notify || ''),
    });
  });
  const prio = { high: 0, med: 1, medium: 1, low: 2 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.due !== b.due) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
    return (prio[a.priority] ?? 3) - (prio[b.priority] ?? 3);
  });
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

function todoDone(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki todo done <slug>'); process.exit(1); }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`error: todo ${slug} not found`); process.exit(2); }
  const { fm, body } = readPageForWrite(p);
  if (fm.type !== 'todo') { console.error(`error: page ${slug} is not a todo (type=${fm.type})`); process.exit(2); }
  fm.status = 'done';
  fm.done_at = nowISO();
  fm.updated = nowISO();
  fs.writeFileSync(p, serializeFrontmatter(fm, body));
  regenerateIndex();
  appendLog('todo:done', slug);
  console.log(`done: ${slug}`);
}

function todoDefer(args) {
  const slug = args._[0];
  if (!slug || !args.to) { console.error('Usage: wiki todo defer <slug> --to YYYY-MM-DD'); process.exit(1); }
  if (!isISODate(String(args.to))) {
    console.error(`error: --to must be YYYY-MM-DD (got "${args.to}")`);
    process.exit(3);
  }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`error: todo ${slug} not found`); process.exit(2); }
  const { fm, body } = readPageForWrite(p);
  if (fm.type !== 'todo') { console.error(`error: page ${slug} is not a todo`); process.exit(2); }
  const oldDue = fm.due || '(none)';
  fm.due = args.to;
  fm.updated = nowISO();
  fs.writeFileSync(p, serializeFrontmatter(fm, body));
  regenerateIndex();
  appendLog('todo:defer', `${slug} (${oldDue} -> ${args.to})`);
  console.log(`deferred: ${slug} → ${args.to}`);
}

module.exports = { cmdTodo };
