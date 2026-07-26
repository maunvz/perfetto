// Copyright (C) 2025 linux_mirror authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import type {Trace} from '../../public/trace';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Tab} from '../../public/tab';
import {NUM, STR} from '../../trace_processor/query_result';

// Displays the call stack captured by ValueMutex when a lock slice is selected.
// Stack frames are emitted as StackFrame instant events at trace flush time
// (see stack_trace_registry.hpp::flush_stack_traces_to_perfetto).
export default class ValueMutexStackPlugin implements PerfettoPlugin {
  static readonly id = 'dev.linuxmirror.ValueMutexStack';

  async onTraceLoad(trace: Trace): Promise<void> {
    // Only activate if this trace contains ValueMutex stack data.
    // TRACE_EVENT_INSTANT lands in the slice table with dur=0, not a separate instant table.
    // Perfetto prefixes debug annotation keys with "debug." in the args table.
    const check = await trace.engine.query(`
      SELECT COUNT(*) AS cnt FROM slice WHERE name = 'StackFrame' AND dur = 0
    `);
    if (check.firstRow({cnt: NUM}).cnt === 0) return;

    // Preload all frames into a hash → symbol[] map. Hashes are cast to TEXT
    // in SQL to avoid JavaScript number precision loss for uint64 values > 2^53.
    // Note: Perfetto stores debug annotation keys with a "debug." prefix in the args table.
    const stackMap = new Map<string, string[]>();
    const rows = await trace.engine.query(`
      SELECT
        CAST(a_hash.int_value AS TEXT)  AS hash,
        CAST(a_depth.int_value AS TEXT) AS depth,
        a_sym.string_value              AS symbol
      FROM slice i
      JOIN args a_hash  ON i.arg_set_id = a_hash.arg_set_id  AND a_hash.key  = 'debug.stack_hash'
      JOIN args a_depth ON i.arg_set_id = a_depth.arg_set_id AND a_depth.key = 'debug.depth'
      JOIN args a_sym   ON i.arg_set_id = a_sym.arg_set_id   AND a_sym.key   = 'debug.symbol'
      WHERE i.name = 'StackFrame' AND i.dur = 0
      ORDER BY a_hash.int_value, a_depth.int_value
    `);
    const it = rows.iter({hash: STR, depth: STR, symbol: STR});
    while (it.valid()) {
      const key = it.hash;
      if (!stackMap.has(key)) stackMap.set(key, []);
      stackMap.get(key)!.push(it.symbol);
      it.next();
    }

    const uri = 'dev.linuxmirror.ValueMutexStack#StackTrace';
    trace.tabs.registerTab({
      uri,
      content: new StackTraceTab(trace, stackMap),
    });
    trace.tabs.showTab(uri);
  }
}

class StackTraceTab implements Tab {
  private lastEventId: number | null = null;
  private currentHash: string | null = null;
  private loading = false;

  constructor(
    private readonly trace: Trace,
    private readonly stackMap: Map<string, string[]>,
  ) {}

  getTitle(): string {
    return 'Stack Trace';
  }

  render(): m.Children {
    const sel = this.trace.selection.selection;

    if (sel.kind !== 'track_event') {
      return m(
        'div',
        {style: 'padding:12px; color:#aaa; font-size:13px'},
        'Select a ValueMutex lock slice to view its call stack.',
      );
    }

    if (sel.eventId !== this.lastEventId) {
      this.lastEventId = sel.eventId;
      this.currentHash = null;
      this.loadHash(sel.eventId);
    }

    if (this.loading) {
      return m('div', {style: 'padding:12px'}, 'Loading…');
    }

    if (this.currentHash === null) {
      return m(
        'div',
        {style: 'padding:12px; color:#aaa; font-size:13px'},
        'No stack trace for this slice.',
      );
    }

    const frames = this.stackMap.get(this.currentHash);
    if (!frames || frames.length === 0) {
      return m(
        'div',
        {style: 'padding:12px; color:#aaa'},
        `Stack hash ${this.currentHash} not found in trace data.`,
      );
    }

    return m(
      'div',
      {style: 'padding:12px; font-family:monospace; font-size:12px'},
      m('div', {style: 'font-weight:bold; margin-bottom:8px; font-size:13px'},
        `Call Stack (${frames.length} frames)`),
      m(
        'table',
        {style: 'border-collapse:collapse; width:100%'},
        frames.map((sym, i) =>
          m(
            'tr',
            {
              style:
                i === 0
                  ? 'background:#1a3a1a; border-bottom:1px solid #333'
                  : 'border-bottom:1px solid #222',
            },
            m(
              'td',
              {style: 'padding:3px 8px; color:#888; user-select:none; width:2em; text-align:right'},
              `#${i}`,
            ),
            m('td', {style: 'padding:3px 8px; word-break:break-all'}, sym),
          ),
        ),
      ),
    );
  }

  private async loadHash(eventId: number): Promise<void> {
    this.loading = true;
    try {
      const result = await this.trace.engine.query(`
        SELECT CAST(a.int_value AS TEXT) AS hash
        FROM slice s
        JOIN args a ON s.arg_set_id = a.arg_set_id
        WHERE s.id = ${eventId} AND a.key = 'debug.stack_hash'
        LIMIT 1
      `);
      if (result.numRows() > 0) {
        this.currentHash = result.firstRow({hash: STR}).hash;
      } else {
        this.currentHash = null;
      }
    } catch {
      this.currentHash = null;
    } finally {
      this.loading = false;
      m.redraw();
    }
  }
}
