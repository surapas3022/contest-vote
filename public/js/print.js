'use strict';
// Printable code cards (A4, 21 per page). Each QR carries the code plus a signature, so scanning skips typing.
let data;
// 8-letter codes are printed as ABCD-EFGH so they are easier to read and type
const fmtCode = (c) => (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c);

async function load() {
  try {
    data = await api('GET', '/api/admin/codes?qr=1');
    draw();
  } catch (e) {
    $('#msg').innerHTML = `<div class="center-state"><div class="banner banner-error">${icon('alert')}<span>${esc(e.status === 401 ? 'ต้องเข้าสู่ระบบแอดมินก่อน แล้วเปิดหน้านี้จากแท็บ “ตั้งค่างาน”' : e.message)}</span></div></div>`;
  }
}
function draw() {
  const list = data.codes.filter((c) => !$('#unused').checked || !c.used);
  $('#title').textContent = `บัตรรหัสโหวต · ${list.length} ใบ (A4 หน้าละ 21 ใบ)`;
  $('#sheet').innerHTML = list.length ? list.map((c) => `<div class="ticket">${c.qr}<div>
    <div class="ev">${esc(data.eventName)}</div>
    <div class="lbl">รหัสโหวตของคุณ</div><div class="code${c.code.length > 6 ? ' long' : ''}">${esc(fmtCode(c.code))}</div>
    <div class="how">สแกน QR หรือเข้า ${esc(data.voteUrl)} แล้วกรอกรหัส</div></div></div>`).join('')
    : '<p class="muted" style="grid-column:1/-1">ไม่มีรหัสให้พิมพ์ สร้างรหัสได้ที่หน้าแอดมิน แท็บ “ตั้งค่างาน”</p>';
}
$('#unused').addEventListener('change', draw);
$('#print').addEventListener('click', () => print());
load();
