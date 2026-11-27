// Inline request cards (approvals, patches, questions) and the Work Story Inspector.
(root => {
  'use strict';
  const {
    sinceText, byteSizeText, visible, visibleCommand, foldBlankRuns, lineChanges,
    isWait, requestToken, toolKind, stepText,
    requestBlocks, requestSummary, workPhase, fileTargetOf,
  } = root.AgentSessionFormat;
  const { t, tp, phrase, locale } = root.AgentSessionI18n;
  const P = root.AgentSessionPanel;
  const {
    specFor, sourceText, navigable, when, quotaAlertText,
    element, button, actionButton, icon, copyButton, inline, breakable,
  } = P;

  const EXIT_PLAN_RE = /^exitplanmode$/i;
  const ENTER_PLAN_RE = /^enterplanmode$/i;
  const DIFF_SIGNS = { same: ' ', removed: '-', added: '+' };
  const CODE_HEADER_LABELS = [phrase('Command to run'), phrase('Patch'), phrase('Plan'), phrase('New cell content')];
  const hasCodeHeader = label => CODE_HEADER_LABELS.some(key => t(key) === label);
  const EXECUTION_FIELDS = [[phrase('Model: {0}'), 'model'], [phrase('Reasoning effort: {0}'), 'effort']];

  function codeBlock(value, label, words, withHeader) {
    const pre = element('pre', 'payload');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', label);
    for (const part of foldBlankRuns(value)) {
      if (part.blank) { pre.append(element('span', 'line same', tp(part.blank, '⋯ {0} blank line ⋯', '⋯ {0} blank lines ⋯'))); continue; }
      for (const logical of (words ? visibleCommand : visible)(part.text).replace(/\n$/, '').split('\n')) {
        const line = element('span', 'line');
        if (!words) line.textContent = logical;
        else for (const piece of logical.split(/([ \t]+)/)) {
          if (piece) line.append(/^[ \t]+$/.test(piece) ? document.createTextNode(piece) : element('span', 'word', piece));
        }
        pre.append(line);
      }
    }
    if (!withHeader) return pre;
    const shell = element('div', 'code-shell');
    const bar = element('div', 'code-bar');
    const title = element('span', 'code-bar-title');
    const barIcon = words ? 'command' : label === t('Plan') ? 'plan' : 'file';
    title.append(icon(barIcon, 'icon tiny'), document.createTextNode(label));
    bar.append(title, copyButton(value, label));
    shell.append(bar, pre);
    return shell;
  }

  function patchBlock(lines, raw) {
    const pre = element('pre', 'payload change');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', t('Patch'));
    if (lines.length) {
      for (const [kind, value] of lines) {
        if (kind === 'hunk') {
          pre.append(element('span', 'line hunk', visible(value)));
        } else {
          pre.append(element('span', 'line ' + kind, (DIFF_SIGNS[kind] || ' ') + ' ' + visible(value)));
        }
      }
    } else {
      const deleted = /^\*\*\* Delete File:/m.test(raw || '');
      pre.append(element('span', 'line same', '  ' + (deleted ? t('(file deleted)') : t('(no changes)'))));
    }
    const shell = element('div', 'code-shell');
    const bar = element('div', 'code-bar');
    const title = element('span', 'code-bar-title');
    title.append(icon('patch', 'icon tiny'), document.createTextNode(t('Patch')));
    bar.append(title, copyButton(raw || '', t('Patch')));
    shell.append(bar, pre);
    return shell;
  }

  function readonlyQuestions(questions) {
    return questions.map(question => {
      const group = element('div', 'question-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', visible(question.question));
      if (question.header) group.append(element('span', 'question-header', visible(question.header)));
      group.append(element('div', 'question', visible(question.question)));
      const notes = [];
      if (question.multiSelect) notes.push(t('You can pick more than one'));
      if (question.isOther) notes.push(t('You can type your own'));
      if (!question.choices.length) notes.push(t('Type your answer in the chat'));
      if (notes.length) group.append(element('div', 'question-note', notes.join(' · ')));
      if (question.choices.length) {
        const list = element('ol', 'choices readonly');
        question.choices.forEach((choice, index) => {
          const row = element('li', 'choice-static');
          const num = element('span', 'choice-index', (index + 1) + '.');
          num.setAttribute('aria-hidden', 'true');
          const body = element('span', 'choice-body');
          body.append(element('span', 'choice-label', visible(choice.label)));
          if (choice.description) body.append(element('span', 'choice-description', visible(choice.description)));
          row.append(num, body);
          list.append(row);
        });
        group.append(list);
      }
      return group;
    });
  }

  function changeBlock(before, after, precomputedOps) {
    const pre = element('pre', 'payload change');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', t('Changes'));
    const ops = precomputedOps || lineChanges(before ? before.split('\n') : [], after ? after.split('\n') : []);
    const keep = ops.map(([kind], at) => kind !== 'same' || (at > 0 && ops[at - 1]?.[0] !== 'same') || (ops[at + 1] && ops[at + 1][0] !== 'same'));
    let folded = false;
    let hasChange = false;
    for (let at = 0; at < ops.length; at++) {
      const [kind, value] = ops[at];
      if (kind !== 'same') hasChange = true;
      if (!keep[at]) {
        if (!folded) pre.append(element('span', 'line same', '  ⋯'));
        folded = true;
        continue;
      }
      folded = false;
      pre.append(element('span', 'line ' + kind, DIFF_SIGNS[kind] + ' ' + visible(value)));
    }
    if (!hasChange) pre.append(element('span', 'line same', '  ' + t('(no changes)')));
    return pre;
  }

  function pathLine(value, owner, stats, file, cwd) {
    const openPath = file || value;
    const cleanCwd = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : '';
    let shown = value;
    if (cleanCwd && !file && value.startsWith(cleanCwd + '/')) {
      const rel = value.slice(cleanCwd.length + 1);
      if (rel && !rel.split('/').includes('..')) shown = rel;
    }
    const row = element('div', 'request-path-row');
    const line = element('div', 'request-path');
    const cut = shown.lastIndexOf('/') + 1;
    const target = owner ? button('request-path-btn', t('Open file {0}', openPath)) : element('span', '');
    if (owner) {
      target.dataset.action = 'openFile';
      target.dataset.target = owner.key;
      target.dataset.file = openPath;
      target.title = openPath + '\n' + t('Click to open in the editor');
    }
    if (cut) target.append(breakable('path-dir', shown.slice(0, cut)));
    target.append(element('strong', 'path-file', inline(shown.slice(cut))));
    line.append(target);
    row.append(line);
    if (stats && (stats.added || stats.removed)) {
      const badge = element('span', 'diff-stats');
      if (stats.added) badge.append(element('span', 'diff-add', '+' + stats.added));
      if (stats.removed) badge.append(element('span', 'diff-del', '−' + stats.removed));
      badge.setAttribute('aria-label', tp(stats.added, '{0} line added', '{0} lines added') + ', ' +
        tp(stats.removed, '{0} line removed', '{0} lines removed'));
      row.append(badge);
    }
    return row;
  }

  function field(name, value) {
    const line = element('div', 'request-field');
    line.append(element('span', 'field-name', visible(name)), breakable('field-value', value));
    return line;
  }

  // 1-entry cache for the single open request card so frequent background activity updates
  // never re-run JSON.parse + O(N×M) LCS lineChanges() while the same card stays open.
  let cachedRequestKey = '';
  let cachedRequestData;
  function getCachedRequest(tool, detail, cwd) {
    const key = locale() + '\0' + (tool || '') + '\0' + (detail || '') + '\0' + (cwd || '');
    if (cachedRequestData && cachedRequestKey === key) return cachedRequestData;
    const blocks = requestBlocks(detail, cwd);
    // Compute lineChanges once per diff block and reuse ops for both stats and rendering.
    const changeOps = new Map();
    const pathStats = new Map();
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].kind !== 'change') continue;
      const b = blocks[i];
      changeOps.set(i, lineChanges(b.before ? b.before.split('\n') : [], b.after ? b.after.split('\n') : []));
    }
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].kind !== 'path') continue;
      let added = 0, removed = 0;
      for (let j = i + 1; j < blocks.length && blocks[j].kind !== 'path'; j++) {
        const ops = changeOps.get(j);
        if (!ops) continue;
        for (let k = 0; k < ops.length; k++) {
          if (ops[k][0] === 'added') added++;
          else if (ops[k][0] === 'removed') removed++;
        }
      }
      if (added || removed) pathStats.set(i, { added, removed });
    }
    const questions = blocks.find(b => b.kind === 'questions')?.questions;
    const summary = requestSummary({ preview: { tool: tool || '', detail: detail || '' } });
    cachedRequestKey = key;
    cachedRequestData = { blocks, changeOps, pathStats, questions, summary };
    return cachedRequestData;
  }

  const SANDBOX_BYPASS_FIELDS = new Set(['BypassSandbox', 'dangerouslyDisableSandbox']);
  function requestContent(tool, detail, cwd, owner) {
    const box = element('div', 'request-content');
    const { blocks, changeOps, pathStats } = getCachedRequest(tool, detail, cwd);
    let fields;
    for (let idx = 0; idx < blocks.length; idx++) {
      const block = blocks[idx];
      if (block.kind === 'field' && SANDBOX_BYPASS_FIELDS.has(block.name) && block.value === 'true') {
        fields = undefined;
        const warn = element('div', 'request-warning');
        warn.setAttribute('role', 'note');
        warn.append(icon('warn', 'icon small'), element('span', '', t('Runs outside the sandbox ({0})', block.name)));
        box.append(warn);
        continue;
      }
      if (block.kind === 'field') {
        if (!fields) {
          fields = element('div', 'request-fields');
          box.append(fields);
        }
        fields.append(field(block.name, block.value));
        continue;
      }
      fields = undefined;
      if (block.kind === 'truncated') {
        const callout = element('div', 'request-truncated');
        callout.setAttribute('role', 'note');
        callout.append(
          icon('warn', 'icon small'),
          element('span', '', t('This request is large, so only the beginning is shown ({0} / {1}) · Review all of it in the chat before you act',
            byteSizeText(block.shownBytes), byteSizeText(block.totalBytes)))
        );
        box.append(callout);
      } else if (block.kind === 'questions') box.append(...readonlyQuestions(block.questions));
      else if (block.kind === 'note') box.append(element('div', 'request-note', visible(block.text)));
      else if (block.kind === 'path') box.append(pathLine(block.text, owner, block.stats || pathStats.get(idx), block.file, cwd));
      else if (block.kind === 'patch') box.append(patchBlock(block.lines, block.raw));
      else if (block.kind === 'code') box.append(codeBlock(block.text, block.label, block.label === t('Command to run'), hasCodeHeader(block.label)));
      else if (block.kind === 'change') box.append(changeBlock(block.before, block.after, changeOps.get(idx)));
      else if (block.kind === 'long') box.append(element('div', 'field-name', visible(block.name)), codeBlock(block.text, block.name, false, false));
      else if (block.kind === 'content') {
        const note = element('div', 'request-warning');
        note.append(icon('warn', 'icon small'), element('span', '', block.text ? t('Replaces the whole file with the content below.') : t('Empties the file. There is no new content.')));
        box.append(note);
        if (block.text) box.append(codeBlock(block.text, t('New file content'), false, false));
      }
    }
    return box;
  }

  function requestHeadline(owner) {
    const request = owner.action;
    if (request?.kind === 'question') return request.questions.length > 1 ? t('{0} questions', request.questions.length) : t('Question');
    if (!request) {
      const qs = getCachedRequest(owner.preview?.tool, owner.preview?.detail, owner.preview?.cwd).questions;
      if (qs) return qs.length > 1 ? t('{0} questions', qs.length) : t('Question');
    }
    const tool = request ? request.tool : owner.preview.tool;
    const more = request?.pendingCount > 1 && t('+{0} more', request.pendingCount - 1);
    if (EXIT_PLAN_RE.test(tool)) return [t('Plan approval'), more].filter(Boolean).join(' · ');
    if (ENTER_PLAN_RE.test(tool)) return [t('Plan mode'), more].filter(Boolean).join(' · ');
    const label = toolKind(tool).label;
    return [label || t('Request'), tool && tool !== label && tool, more].filter(Boolean).join(' · ');
  }

  function executionNote(row, now = Date.now()) {
    const e = row.execution || {};
    return EXECUTION_FIELDS.map(([label, name]) => {
      const stamp = when(e[name + 'At'], now);
      return t(label, e[name] || t('Unknown')) + (e[name] ? ' · ' + sourceText(e[name + 'Source']) +
        (stamp ? ' · ' + stamp : '') : '');
    }).join('\n');
  }

  function renderRequest(owner, ctx) {
    const request = owner.action;
    const token = ctx.derived.tokenOf.get(owner.key) ?? requestToken(owner);
    const now = ctx.now;
    const box = element('div', 'request');
    box.dataset.request = token;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('{0} request', owner.title));
    const queue = ctx.derived.queue;
    if (queue.length >= 2) {
      const pos = queue.findIndex(r => ctx.derived.tokenOf.get(r.key) === token);
      if (pos >= 0) {
        const triage = element('div', 'request-triage');
        const pill = element('span', 'queue-pill');
        pill.append(element('span', 'queue-label', t('Pending requests')), element('span', 'queue-counter', (pos + 1) + ' / ' + queue.length));
        const stepper = element('div', 'queue-stepper');
        stepper.setAttribute('role', 'group');
        stepper.setAttribute('aria-label', t('Switch pending request'));
        const prevBtn = button('queue-step', t('Previous pending request'));
        prevBtn.dataset.control = 'queueStep';
        prevBtn.dataset.direction = 'prev';
        prevBtn.title = t('Previous pending request');
        prevBtn.append(icon('back', 'icon tiny'), element('span', 'queue-step-label', t('Previous')));
        const nextBtn = button('queue-step', t('Next pending request'));
        nextBtn.dataset.control = 'queueStep';
        nextBtn.dataset.direction = 'next';
        nextBtn.title = t('Next pending request');
        nextBtn.append(element('span', 'queue-step-label', t('Next')), icon('turn', 'icon tiny'));
        stepper.append(prevBtn, nextBtn);
        triage.append(pill, stepper);
        box.append(triage);
      }
    }
    const expired = Boolean(request?.expiresAt) && now >= request.expiresAt;
    const sendingAction = ctx.sending?.get(token);
    const isSending = Boolean(sendingAction);
    const about = request?.kind === 'question'
      ? requestSummary(owner)
      : request
        ? getCachedRequest(request.tool, request.detail, request.cwd).summary
        : '';
    const decide = (action, caption, style, keys) => {
      const activeSending = sendingAction === action;
      const shownCaption = activeSending ? t('Sending…') : caption;
      const control = actionButton(owner, action, shownCaption, style + (activeSending ? ' is-sending' : ''));
      control.title = caption + ' · ' + keys;
      control.setAttribute('aria-label', [owner.title, shownCaption, about].filter(Boolean).map(visible).join(' · '));
      control.disabled = expired || isSending;
      return control;
    };
    const actions = element('div', 'actions');
    let hint = '';
    if (!request) {
      box.classList.add('is-preview');
      const cached = getCachedRequest(owner.preview.tool, owner.preview.detail, owner.preview.cwd);
      const isQuestion = owner.status === 'input' || Boolean(cached.questions);
      const hasChoices = Boolean(cached.questions?.some(q => q.choices.length));
      const providerName = specFor(owner.provider)[1];
      const previewTarget = owner.viaParent ? t('the parent chat') : providerName;
      const previewVerb = hasChoices
        ? t('Choose an option')
        : isQuestion
          ? t('Answer it')
          : EXIT_PLAN_RE.test(owner.preview.tool)
            ? t('Approve the plan')
            : ENTER_PLAN_RE.test(owner.preview.tool)
              ? t('Confirm plan mode')
              : t('Handle it');
      const banner = element('div', 'preview-banner');
      banner.setAttribute('role', 'note');
      const bannerText = navigable(owner)
        ? t('Read-only preview · {0} in {1}', previewVerb, previewTarget)
        : t('Read-only preview · {0} in the original chat', previewVerb);
      banner.append(icon('read', 'icon tiny'), element('span', 'preview-banner-text', bannerText));
      box.append(banner);
      const content = requestContent(owner.preview.tool, owner.preview.detail, owner.preview.cwd, owner);
      if (!content.childNodes.length) {
        if (EXIT_PLAN_RE.test(owner.preview.tool)) {
          content.append(element('div', 'request-note', t('Review and approve the written plan in the chat.')));
        } else if (ENTER_PLAN_RE.test(owner.preview.tool)) {
          content.append(element('div', 'request-note', t('Confirm in the chat whether to switch to plan mode.')));
        }
      }
      box.append(content);
      if (navigable(owner)) {
        const ctaLabel = owner.viaParent
          ? (isQuestion ? t('Answer in the parent chat') : t('Review in the parent chat'))
          : (isQuestion ? t('Answer in {0}', providerName) : t('Review in {0}', providerName));
        const openChat = actionButton(owner, 'review', ctaLabel, 'preview-cta');
        openChat.append(icon('out', 'icon tiny'));
        actions.append(openChat);
      }
    } else if (request.kind === 'approval') {
      const content = requestContent(request.tool, request.detail, request.cwd, owner);
      box.append(content);
      const summaryNode = element('span', 'sr-only', [requestHeadline(owner), about].filter(Boolean).map(visible).join(' · '));
      summaryNode.id = 'request-summary';
      box.append(summaryNode);
      for (const control of [request.deny && decide('deny', t('Deny'), 'secondary', ctx.chord.deny),
        request.allow && decide('approve', t('Allow once'), 'primary', ctx.chord.allow)]) {
        if (!control) continue;
        control.setAttribute('aria-describedby', summaryNode.id);
        actions.append(control);
      }
      hint = [request.allow && t('{0} Allow', ctx.chord.allow), request.deny && t('{0} Deny', ctx.chord.deny)].filter(Boolean).join(' · ');
    } else {
      const direct = request.questions.length === 1 && !request.questions[0].multiSelect;
      const draft = ctx.draftFor(token, request.questions);
      let number = 0;
      request.questions.forEach((question, at) => {
        const group = element('div', 'question-group');
        group.dataset.index = String(at);
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', question.question);
        if (question.header) group.append(element('span', 'question-header', visible(question.header)));
        group.append(element('div', 'question', visible(question.question)));
        if (question.multiSelect) group.append(element('div', 'question-note', t('You can pick more than one')));
        const list = element('div', 'choices');
        question.choices.forEach((choice, index) => {
          number++;
          const option = button('choice', [question.question, choice.label, choice.description].filter(Boolean).map(visible).join(' · '));
          option.disabled = expired || isSending;
          option.dataset.target = owner.key;
          option.dataset.question = at;
          option.dataset.index = index;
          const picked = !direct && draft[at].has(index);
          const key = element('kbd', 'keycap', number <= 9 ? String(number) : '');
          key.setAttribute('aria-hidden', 'true');
          if (number <= 9) option.dataset.hotkey = number;
          const body = element('span', 'choice-body');
          body.append(element('span', 'choice-label', visible(choice.label)));
          if (choice.description) body.append(element('span', 'choice-description', visible(choice.description)));
          if (direct) {
            option.dataset.action = 'answer';
            option.append(key, body);
          } else {
            const tick = element('span', 'choice-mark' + (question.multiSelect ? ' multi' : ''));
            if (picked) tick.append(icon('check', 'icon tiny'));
            option.dataset.control = 'choice';
            option.setAttribute('aria-pressed', String(picked));
            option.append(tick, body, key);
          }
          list.append(option);
        });
        group.append(list);
        box.append(group);
      });
      if (!direct) {
        const send = decide('answer', t('Send answer'), 'primary', ctx.chord.allow);
        send.disabled = expired || isSending || draft.some(picked => !picked.size);
        actions.append(send);
      }
      hint = direct ? t('Press a number to choose') : t('Press a number to choose · {0} Send', ctx.chord.allow);
    }
    if (actions.childNodes.length === 1) actions.classList.add('single');
    if (actions.childNodes.length) box.append(actions);
    if (ctx.refuseNotice?.token === token && ctx.refuseNotice.message) {
      const refuseBox = element('div', 'refuse-note');
      refuseBox.setAttribute('role', 'status');
      refuseBox.append(icon('warn', 'icon tiny'), element('span', '', ctx.refuseNotice.message));
      box.append(refuseBox);
    }
    if (request) {
      const foot = element('div', 'request-foot');
      const link = actionButton(owner, 'defer', t('Open in chat'), 'text-button');
      link.append(icon('out', 'icon tiny'));
      foot.append(link, element('span', 'request-hint', hint));
      box.append(foot);
    }
    return box;
  }

  // Session Work Story Inspector: intuitive breakdown of goal, plan, modified files, timeline, and outcome.
  function renderDetail(row, ctx) {
    const now = ctx.now;
    const box = element('div', 'row-menu');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('{0} work summary', row.title));
    let execNote;
    const getExecNote = () => execNote ?? (execNote = executionNote(row, now));

    // Phase header strip
    const phase = workPhase(row);
    const head = element('div', 'story-head');
    const pill = element('span', 'phase-pill');
    pill.dataset.phase = phase.kind;
    pill.append(element('span', 'phase-dot'), document.createTextNode(phase.label));
    head.append(pill);
    if (row.updatedAt) {
      const stamp = element('span', 'story-stamp', t('Last active {0}', when(row.updatedAt, now)));
      stamp.title = getExecNote();
      head.append(stamp);
    }
    box.append(head);

    if (row.status === 'working' && row.focus) {
      const focusLine = element('div', 'story-focus');
      focusLine.append(icon('focus', 'icon tiny'), element('span', 'story-focus-text', visible(row.focus)));
      box.append(focusLine);
    }

    const part = (key, label, body, rightControl) => {
      const section = element('div', 'detail-part');
      section.dataset.key = key;
      const header = element('div', 'detail-head');
      header.append(element('span', 'detail-label', label));
      if (rightControl) header.append(rightControl);
      section.append(header, body);
      box.append(section);
    };

    // 0. Contextual quota or no-signal banner
    const quotaHint = ctx.quotaHintForError(row);
    if (quotaHint) {
      const banner = element('div', 'story-banner is-quota');
      banner.append(icon('warn', 'icon tiny'), element('span', 'story-banner-text', quotaAlertText(quotaHint, false, now)));
      const openQuota = button('text-button story-banner-link', t('View {0} subscription limits', specFor(row.provider)[1]), t('View limits'));
      openQuota.dataset.control = 'quotaTile';
      openQuota.dataset.provider = row.provider;
      banner.append(openQuota);
      box.append(banner);
    } else if (row.quiet) {
      const banner = element('div', 'story-banner is-quiet');
      const quietMsg = row.status === 'approval' || row.status === 'input'
        ? t('The request was declined or got no response, so it is no longer waiting. Open the chat to check, or hide it.')
        : row.isSubagent
          ? t('No response for a long time, so it looks finished. You can clean it up or hide it.')
          : t('No signal for over 15 minutes. If the work stopped, hide it or open the chat to check.');
      banner.append(element('span', 'story-banner-text', quietMsg));
      box.append(banner);
    }

    // 1. Prompt / Goal
    if (row.prompt) {
      const card = element('div', 'detail-card');
      const isExpanded = ctx.expandedPrompts.has(row.key);
      const p = element('p', 'detail-text' + (isExpanded ? ' expanded' : ''), visible(row.prompt));
      card.append(p);
      if (row.prompt.length > 110 || row.prompt.includes('\n')) {
        const moreBtn = button('text-button', isExpanded ? t('Collapse request') : t('Show full request'), isExpanded ? t('Collapse') : t('Show all'));
        moreBtn.dataset.control = 'expandPrompt';
        moreBtn.dataset.target = row.key;
        card.append(moreBtn);
      }
      part('prompt', t('Request'), card, copyButton(row.prompt, t('Request')));
    }

    // 2. Plan Checklist
    if (row.plan?.length) {
      const wrap = element('div', '');
      const done = row.progress ? row.progress.done : row.plan.filter(p => p.status === 'completed').length;
      const total = row.progress ? row.progress.total : row.plan.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const bar = element('div', 'plan-progress-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('Plan progress'));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(pct));
      const fill = element('div', 'plan-progress-fill' + (done >= total ? ' complete' : ''));
      fill.style.transform = 'scaleX(' + Number((pct / 100).toFixed(4)) + ')';
      bar.append(fill);
      wrap.append(bar);
      const list = element('ul', 'plan-list');
      row.plan.forEach((entry, idx) => {
        const li = element('li', 'plan-item');
        li.dataset.index = String(idx);
        li.dataset.state = entry.status;
        const mark = element('span', 'plan-mark');
        if (entry.status === 'completed') mark.append(icon('check', 'icon tiny plan-check'));
        else if (entry.status === 'in_progress') mark.append(element('span', 'plan-active-dot'));
        else if (entry.status === 'failed') mark.append(icon('fail', 'icon tiny plan-fail'));
        else if (entry.status === 'skipped') mark.append(element('span', 'plan-skip-dot'));
        else mark.append(element('span', 'plan-pending-dot'));
        li.append(mark, element('span', 'plan-text', visible(entry.text)));
        list.append(li);
      });
      wrap.append(list);
      part('plan', t('Work plan'), wrap, element('span', 'detail-stat', done + '/' + total + ' · ' + pct + '%'));
    }

    // 3. Modified Files (clickable to open directly in VS Code!)
    if (row.changedFiles?.length) {
      const chips = element('div', 'file-chips');
      for (const file of row.changedFiles) {
        const chip = button('file-chip', t('Open {0} in the editor', file));
        chip.dataset.action = 'openFile';
        chip.dataset.target = row.key;
        chip.dataset.file = file;
        chip.title = file + '\n' + t('Click to open in the editor');
        chip.append(icon('file', 'icon tiny'));
        const text = element('span', 'file-chip-text');
        const cut = file.lastIndexOf('/') + 1;
        if (cut) text.append(element('span', 'file-chip-dir', visible(file.slice(0, cut))));
        text.append(element('span', 'file-chip-name', visible(file.slice(cut))));
        chip.append(text, icon('out', 'icon tiny file-chip-open'));
        chips.append(chip);
      }
      const statText = row.changed && row.changed > row.changedFiles.length
        ? t('Latest {1} of {0}', row.changed, row.changedFiles.length)
        : tp(row.changed || row.changedFiles.length, '{0} file', '{0} files');
      part('files', t('Changed files'), chips, element('span', 'detail-stat', statText));
    }

    // 4. Live Step Timeline
    const current = row.steps?.[0] && row.activity && row.steps[0].tool === row.activity.tool && row.steps[0].target === row.activity.target;
    const steps = (row.steps || []).slice(current && row.status === 'working' ? 1 : 0);
    if (steps.length) {
      const list = element('ol', 'steps');
      steps.forEach((step, idx) => {
        const entry = element('li', 'step' + (step.failed ? ' failed' : ''));
        entry.dataset.key = (step.at || idx) + ':' + (step.tool || '') + ':' + (step.target || '');
        const node = element('span', 'step-node');
        node.append(icon(toolKind(step.tool).kind, 'icon tiny'));
        const mainText = element('span', 'step-main');
        const stepLabel = stepText(step);
        const shownLabel = visible(stepLabel);
        const openable = fileTargetOf(step);
        if (openable) {
          const link = button('step-link', toolKind(step.tool).label + ' · ' + t('Open file {0}', openable), shownLabel);
          link.dataset.action = 'openFile';
          link.dataset.target = row.key;
          link.dataset.file = openable;
          link.title = openable + '\n' + t('Click to open in the editor');
          mainText.append(link);
        } else {
          mainText.append(element('span', 'step-text', shownLabel));
        }
        if (step.failed) mainText.append(element('span', 'step-fail', t('Failed')));
        entry.append(node, mainText);
        if (step.at) {
          const time = element('time', 'step-time', sinceText('ago', step.at, now) || t('just now'));
          time.dataset.since = step.at;
          time.dataset.kind = 'ago';
          time.dataset.fallback = t('just now');
          entry.append(time);
        }
        list.append(entry);
      });
      part('steps', steps.length < (row.steps || []).length ? t('Earlier steps') : t('Activity'), list);
    }

    // 5. Last Reply
    if (row.reply && (row.status === 'done' || row.status === 'error')) {
      const card = element('div', 'detail-card ' + (row.status === 'error' ? 'reply-error' : 'reply-done'));
      card.append(element('p', 'detail-text expanded', visible(row.reply)));
      part('reply', row.status === 'error' ? t('Error details') : t('Last reply'), card, copyButton(row.reply, t('Reply')));
    }

    // 6. Metadata & Action Bar
    const facts = [row.execution?.model, row.execution?.effort && t('Effort {0}', row.execution.effort), row.usage].filter(Boolean);
    if (facts.length) {
      const line = element('div', 'detail-meta', facts.join(' · '));
      line.title = getExecNote();
      box.append(line);
    }
    const tools = element('div', 'detail-actions');
    if (navigable(row)) {
      const openBtn = actionButton(row, isWait(row) ? 'review' : 'open', t('Open chat'), 'mini accent');
      openBtn.append(icon('out', 'icon tiny'));
      tools.append(openBtn);
    }
    if (row.replyUnread) {
      const seen = actionButton(row, 'markSeen', t('Mark as read'), 'mini');
      seen.dataset.replyAt = row.replyAt;
      tools.append(seen);
    }
    if (row.status === 'error' && !row.errorAcked && row.updatedAt) {
      const ack = actionButton(row, 'ackError', t('Acknowledge'), 'mini');
      ack.dataset.updatedAt = row.updatedAt;
      ack.title = t('Moves it out of Needs attention and keeps it under Earlier.');
      tools.append(ack);
    }
    if (!row.isSubagent) {
      const pin = actionButton(row, 'setPinned', row.pinned ? t('Unpin') : t('Pin'), 'mini');
      pin.dataset.value = String(!row.pinned);
      tools.append(pin);
    }
    tools.append(actionButton(row, 'rename', t('Rename'), 'mini'));
    if ((row.status !== 'working' && row.status !== 'approval' && row.status !== 'input') || row.quiet) {
      tools.append(actionButton(row, 'dismiss', t('Hide'), 'mini'));
    }
    box.append(tools);
    return box;
  }

  Object.assign(P, {
    requestHeadline, executionNote, renderRequest, renderDetail,
  });
})(globalThis);
