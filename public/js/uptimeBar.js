'use strict';

/**
 * Renders the segmented uptime history bar. Each segment is a colored block:
 * green = operational, yellow = degraded, red = outage, dark = no data.
 * Clicking a segment shows a popover with details for that period.
 */
function renderUptimeBar(container, segments, { onHover, size = '' } = {}) {
  container.innerHTML = '';
  container.classList.add('uptime-bar');
  if (size) container.classList.add(size);

  if (!segments || segments.length === 0) {
    container.appendChild(el('div', { class: 'seg seg-none' }));
    return;
  }

  for (const seg of segments) {
    const div = el('div', {
      class: `seg seg-${seg.status}`,
      role: 'button',
      tabindex: '0',
      title: segmentTitle(seg),
    });
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      showSegmentPopover(div, seg, e);
    });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showSegmentPopover(div, seg, e);
      }
    });
    container.appendChild(div);
  }
}

function segmentTitle(seg) {
  const time = `${fmtClock(seg.start)} \u2013 ${fmtClock(seg.end)}`;
  const status = { up: 'Operational', degraded: 'Degraded', down: 'Outage', none: 'No data' }[seg.status];
  return `${time} \u00b7 ${status} \u00b7 ${seg.checks} check${seg.checks === 1 ? '' : 's'}`;
}

function showSegmentPopover(anchor, seg, event) {
  const existing = document.querySelector('.popover');
  if (existing) existing.remove();

  const status = {
    up: ['Operational', 'var(--green)'],
    degraded: ['Degraded', 'var(--yellow)'],
    down: ['Outage', 'var(--red)'],
    none: ['No data', 'var(--gray)'],
  }[seg.status];

  const pop = el('div', { class: 'popover' }, [
    el('h4', null, `${fmtDateTime(seg.start)} \u2013 ${fmtClock(seg.end)}`),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Status'),
      el('span', { class: 'v', style: `color: ${status[1]}` }, status[0]),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Checks'),
      el('span', { class: 'v' }, String(seg.checks)),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Operational'),
      el('span', { class: 'v' }, String(seg.up)),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Degraded'),
      el('span', { class: 'v' }, String(seg.degraded)),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Failures'),
      el('span', { class: 'v' }, String(seg.down)),
    ]),
  ]);

  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  let top = rect.bottom + 8;
  if (left < 10) left = 10;
  if (left + popRect.width > window.innerWidth - 10) {
    left = window.innerWidth - popRect.width - 10;
  }
  if (top + popRect.height > window.innerHeight - 10) {
    top = rect.top - popRect.height - 8;
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  const dismiss = (e) => {
    if (!pop.contains(e.target)) {
      pop.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', keyDismiss, true);
    }
  };
  const keyDismiss = (e) => {
    if (e.key === 'Escape') {
      pop.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', keyDismiss, true);
    }
  };
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('keydown', keyDismiss, true);
}
