import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackEvent, SlackSender } from '../src/platforms/slack.ts';
import { makeBridge } from './helpers.ts';

const opts = { botToken: 'xoxb-test', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };
const CH = 'C0C4FMZKJR2';

const file = (id: string, name: string, mimetype: string, withUrl = true) => ({
  id, name, mimetype, mode: 'hosted',
  ...(withUrl ? { url_private: `https://files.slack.com/files-pri/T-${id}/${name}`, url_private_download: `https://files.slack.com/files-pri/T-${id}/download/${name}` } : { file_access: 'check_file_info' }),
});

/** Carmel's upload in #kita-testcustomer: subtype None, empty text, files[] with url_private_download. */
const event = (ev: Record<string, unknown>) => ({
  type: 'event_callback', team_id: 'TKITA0001', authorizations: [{ is_bot: true, user_id: 'UBOT' }],
  event: { type: 'message', channel: CH, ts: '1790379193.659569', text: '', ...ev },
});
const staff = { user: 'U0B1Z7ABWD7', user_team: 'TKITA0001' };
const customer = { user: 'UCUST001', user_team: 'TCUST0001' };

const parsed = (payload: unknown) => {
  const p = parseSlackEvent(payload, opts);
  assert.equal(p.kind, 'message', `expected a message, got ${JSON.stringify(p)}`);
  return p.kind === 'message' ? p.message : (undefined as never);
};

test('a file-only message (no subtype, empty text) is a message with its files', () => {
  const m = parsed(event({ ...staff, files: [file('F1', 'image.png', 'image/png')] }));
  assert.equal(m.author, 'staff');
  assert.equal(m.text, '');
  assert.deepEqual(m.attachments.map((a) => [a.name, a.contentType]), [['image.png', 'image/png']]);
  assert.deepEqual(m.attachments[0].headers, { authorization: 'Bearer xoxb-test' });
  assert.deepEqual(m.echoKeys, ['file:F1']);
});

test('the file_share subtype, several files, and files in a thread', () => {
  const m = parsed(event({
    ...customer, subtype: 'file_share', thread_ts: '1790379000.000100',
    files: [file('F1', 'image.png', 'image/png'), file('F2', 'contract.pdf', 'application/pdf'), file('F3', 'data.csv', 'text/csv')],
  }));
  assert.equal(m.attachments.length, 3);
  assert.deepEqual(m.thread, { root: `${CH}:1790379000.000100`, reply: true });
});

test('files listed without a URL (check_file_info) are kept for files.info, never dropped', () => {
  const m = parsed(event({ ...staff, files: [file('F1', 'image.png', 'image/png', false)] }));
  assert.deepEqual(m.attachments, []);
  assert.deepEqual(m.pendingFileIds, ['F1']);
});

test('an upload finishing as message_changed imports the edited message with its files', () => {
  const m = parsed(event({
    subtype: 'message_changed', ts: '1790379194.000000',
    message: { type: 'message', ...staff, ts: '1790379193.659569', text: '', files: [file('F1', 'image.png', 'image/png')] },
  }));
  assert.equal(m.eventId, `${CH}:1790379193.659569`);
  assert.equal(m.attachments.length, 1);
  const edit = parseSlackEvent(event({ subtype: 'message_changed', message: { ...staff, ts: '1', text: 'edited' } }), opts);
  assert.deepEqual(edit, { kind: 'ignore', reason: 'subtype:message_changed' });
  assert.deepEqual(parseSlackEvent(event({ ...staff }), opts), { kind: 'ignore', reason: 'empty' });
});

test('a customer file-only message reaches the desk as attachments', async () => {
  const { bridge, cw } = makeBridge();
  const m = parsed(event({ ...customer, files: [file('F1', 'image.png', 'image/png'), file('F2', 'contract.pdf', 'application/pdf')] }));
  assert.equal(await bridge.inbound({ ...m, userName: 'Maria' }), 'created');
  const post = cw.calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.path))!;
  assert.deepEqual(post.body.files, ['image.png', 'contract.pdf']);
  assert.equal(post.body.content, '');
});

test('a Kita staff file-only message reaches the staff endpoint as attachments', async () => {
  const { bridge, deskCalls } = makeBridge();
  const m = parsed(event({ ...staff, files: [file('F1', 'image.png', 'image/png')] }));
  assert.equal(await bridge.inbound({ ...m, userName: 'Carmel', userEmail: 'carmel@kita.ai' }), 'staff_synced');
  const staffCall = deskCalls.find((c) => c.path === '/api/v1/kita/staff_messages')!;
  assert.deepEqual(staffCall.body.files, ['image.png']);
  assert.equal(staffCall.body.content, '');
});

test('files listed without a URL are resolved through files.info before delivery', async () => {
  const lookups: string[] = [];
  const { bridge, deskCalls } = makeBridge({
    slackFile: async (id) => {
      lookups.push(id);
      return { url: `https://files.slack.com/files-pri/T-${id}/download/image.png`, name: 'image.png', contentType: 'image/png' };
    },
  });
  const m = parsed(event({ ...staff, files: [file('F1', 'image.png', 'image/png', false)] }));
  assert.equal(await bridge.inbound({ ...m, userName: 'Carmel' }), 'staff_synced');
  assert.deepEqual(lookups, ['F1']);
  assert.deepEqual(deskCalls.find((c) => c.path === '/api/v1/kita/staff_messages')!.body.files, ['image.png']);
});

test('dedupe still holds: our own uploaded file echoes and a repeated event are not imported twice', async () => {
  const { bridge, store } = makeBridge();
  store.markSeen('in:slack:file:F9'); // the file an agent's reply uploaded
  const echo = parsed(event({ ...staff, ts: '1790379300.000001', files: [file('F9', 'guide.pdf', 'application/pdf')] }));
  assert.equal(await bridge.inbound(echo), 'duplicate');

  const m = parsed(event({ ...customer, files: [file('F1', 'image.png', 'image/png')] }));
  assert.equal(await bridge.inbound({ ...m, userName: 'Maria' }), 'created');
  assert.equal(await bridge.inbound({ ...m, userName: 'Maria' }), 'duplicate');
});

test('SlackSender.fileAttachment reads files.info with the bot token', async () => {
  const calls: string[] = [];
  const sender = new SlackSender('xoxb-test', async () => undefined, (async (u: any) => {
    calls.push(String(u));
    return Response.json({ ok: true, file: file('F1', 'image.png', 'image/png') });
  }) as typeof fetch);
  const a = await sender.fileAttachment('F1');
  assert.equal(a?.url, 'https://files.slack.com/files-pri/T-F1/download/image.png');
  assert.match(calls[0], /files\.info\?file=F1/);
});
