"""오늘의 발자국 — Playwright 검증 (390×844 모바일 / 1280×800 PC)

    LD_LIBRARY_PATH=/workspace/.browserlibs/lib python3 test_app.py

검증 (달력 아래 '선택한 날의 발자국' 카드 v2)
- 첫 화면: 작은 제목 + 월간 달력 + 달력 바로 아래 오늘(기본 선택)의 기록/작성 카드
- 오늘 기본 선택 표시, 달력 아래 빈 공간 없이 카드가 이어짐, 가로 넘침 0
- 날짜를 누르면 선택 강조가 옮겨 가고 아래 카드 제목·내용이 그 날짜로 즉시 전환
- 🏠 집 기록(사진 없이 내용만) 저장 → 아래 카드·달력 🏠 → 새로고침 후 IndexedDB 유지
- 📍 외출 기록(장소 + 실제 JPEG 업로드 + 내용) 저장 → 카드 사진 썸네일 → 새로고침 유지
- 하루 여러 곳(+N 배지), + 기록 추가, 수정·삭제, 집/외출 종류 전환, 자주 가는 장소 칩
- 장소·내용 검색 → 결과를 누르면 그 날짜가 선택되고 아래 카드로 이동
- JSON 내보내기 / 새 저장공간에서 불러오기(사진 포함)
- 라이트박스, PC 레이아웃, 콘솔 오류 0
- 대표 스크린샷 downloads/place_diary/
"""
import datetime
import functools
import http.server
import json
import os
import socketserver
import threading

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SHOTS = '/workspace/downloads/place_diary'
os.makedirs(SHOTS, exist_ok=True)
REPO_SHOTS = os.path.join(ROOT, 'shots')
os.makedirs(REPO_SHOTS, exist_ok=True)
FIXTURES = os.path.join(ROOT, 'test-fixtures')
os.makedirs(FIXTURES, exist_ok=True)

PASSES, FAILS = [], []


def check(name, cond, extra=''):
    if cond:
        PASSES.append(name)
        print('PASS  ' + name)
    else:
        FAILS.append(name)
        print('FAIL  ' + name + (' — ' + str(extra) if extra else ''))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Handler, directory=ROOT))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d/' % PORT


# ---------------------------------------------------------------- 테스트 사진
def make_photo(path, size, top, bottom, label):
    w, h = size
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        col = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = col
    d = ImageDraw.Draw(img)
    d.ellipse([w * 0.1, h * 0.1, w * 0.42, h * 0.55], fill=(255, 245, 210))
    d.rectangle([w * 0.5, h * 0.55, w * 0.9, h * 0.9], fill=(255, 255, 255))
    d.text((int(w * 0.52), int(h * 0.62)), label, fill=(40, 48, 60))
    img.save(path, quality=92)
    return path


PHOTO_A = make_photo(os.path.join(FIXTURES, 'test_cafe_landscape.jpg'), (1600, 1200),
                     (255, 214, 165), (120, 160, 220), 'CAFE 2026')
PHOTO_B = make_photo(os.path.join(FIXTURES, 'test_church_portrait.jpg'), (1200, 1600),
                     (198, 226, 255), (255, 236, 210), 'CHURCH 2026')

KEY_JS = """(n) => {
    const d = new Date();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const p = (x) => String(x).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}"""
WEEK = ['월', '화', '수', '목', '금', '토', '일']


def day_label(key):
    y, m, d = [int(x) for x in key.split('-')]
    wd = WEEK[datetime.date(y, m, d).weekday()]
    return f'{m}월 {d}일 ({wd})'


def new_page(browser, w=390, h=844, mobile=True):
    ctx = browser.new_context(
        viewport={'width': w, 'height': h},
        timezone_id='Asia/Seoul',
        locale='ko-KR',
        is_mobile=mobile,
        has_touch=mobile,
        device_scale_factor=2 if mobile else 1,
        accept_downloads=True,
    )
    page = ctx.new_page()
    console_errors, page_errors, failed = [], [], []

    def on_console(msg):
        if msg.type == 'error':
            text = msg.text
            if 'favicon' in text:
                return
            console_errors.append(text)

    page.on('console', on_console)
    page.on('pageerror', lambda e: page_errors.append(str(e)))
    page.on('requestfailed', lambda r: failed.append(r.url + ' :: ' + str(r.failure)))
    return ctx, page, console_errors, page_errors, failed


def overflow(page):
    return page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")


def today_key(page):
    return page.evaluate(KEY_JS, 0)


def shift_key(page, n):
    return page.evaluate(KEY_JS, n)


def db_dump(page):
    return page.evaluate("""() => new Promise((resolve, reject) => {
        const rq = indexedDB.open('place-diary');
        rq.onerror = () => reject(String(rq.error));
        rq.onsuccess = () => {
            const db = rq.result;
            const tx = db.transaction(['entries', 'photos', 'settings']);
            const out = {};
            tx.objectStore('entries').getAll().onsuccess = (e) => { out.entries = e.target.result; };
            tx.objectStore('photos').getAll().onsuccess = (e) => {
                out.photos = e.target.result.map((p) => ({ id: p.id, entryId: p.entryId, date: p.date,
                    fullSize: p.full.size, thumbSize: p.thumb.size, fullType: p.full.type }));
            };
            tx.objectStore('settings').getAll().onsuccess = (e) => { out.settings = e.target.result; };
            tx.oncomplete = () => resolve(out);
        };
    })""")


def save_shot(page, name, target_dir=SHOTS):
    path = os.path.join(target_dir, name)
    page.screenshot(path=path)
    return path


def open_day(page, key):
    page.click(f'.day[data-date="{key}"]')
    page.wait_for_selector(f'.day[data-date="{key}"].selected')
    page.wait_for_timeout(420)


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])

    # ============================================================ 모바일
    ctx, page, console_errors, page_errors, failed = new_page(browser, 390, 844)
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.days .day')
    page.wait_for_timeout(600)
    day = today_key(page)

    # --- 첫 화면: 제목 + 달력 + 달력 아래 오늘 카드
    title = page.locator('.app-title')
    check('제목 "오늘의 발자국" 표시', title.inner_text().strip() == '오늘의 발자국')
    fs = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.app-title')).fontSize)")
    check('제목이 작다 (18px 이하)', fs <= 18, fs)
    check('main 안에 달력 카드 + 오늘 카드 2개', page.evaluate("() => document.querySelectorAll('main > .card').length") == 2)
    check('상단 버튼은 검색·백업 2개', page.evaluate("() => document.querySelectorAll('.top-actions .icon-btn').length") == 2)
    check('요일 7칸', page.evaluate("() => document.querySelectorAll('.weekdays span').length") == 7)

    cal_box = page.evaluate("""() => {
        const c = document.querySelector('.cal-card').getBoundingClientRect();
        const d = document.querySelector('#dayCard').getBoundingClientRect();
        return { calBottom: Math.round(c.bottom), dayTop: Math.round(d.top), dayBottom: Math.round(d.bottom) };
    }""")
    check('달력 바로 아래에 오늘 카드 (간격 8~20px)',
          8 <= cal_box['dayTop'] - cal_box['calBottom'] <= 20, cal_box)
    check('달력이 첫 화면 안에 다 보인다', cal_box['calBottom'] <= 844, cal_box['calBottom'])
    check('오늘 카드가 달력 아래 빈 공간 없이 이어진다 (첫 화면 안)',
          cal_box['dayBottom'] <= 844, cal_box['dayBottom'])

    # --- 오늘 기본 선택
    selected = page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)")
    check('기본 선택 날짜는 오늘', selected == [day], selected)
    check('오늘 칸에 today 표시', page.locator(f'.day[data-date="{day}"].today').count() == 1)
    check('선택 날짜 제목이 오늘', page.locator('#dayTitle').inner_text().strip() == day_label(day),
          page.locator('#dayTitle').inner_text())
    check('오늘 배지 표시', page.locator('#dayPill').is_visible() and page.locator('#dayPill').inner_text().strip() == '오늘')
    check('카드 안내: 아직 오늘의 발자국이 없어요',
          page.locator('#dayEmptyTitle').inner_text().strip() == '아직 오늘의 발자국이 없어요')

    # --- 기록 없는 날은 달력 아래에서 바로 적는 입력칸이 펼쳐져 있음
    check('빈 날이면 바로 쓰는 입력칸이 펼쳐짐', page.locator('#entryForm').is_visible())
    check('집 모드: 장소 칸 없음', page.locator('#placeField').is_hidden())
    check('집 모드: 사진 칸 없음', page.locator('#photoField').is_hidden())
    check('집 빠른 버튼이 활성', page.locator('#quickHome').get_attribute('aria-pressed') == 'true')
    check('외출 빠른 버튼은 비활성', page.locator('#quickOuting').get_attribute('aria-pressed') == 'false')
    check('빠른 버튼 2개', page.locator('.quick-row .quick-btn').count() == 2)
    check('가로 넘침 없음(첫 화면 390)', overflow(page) <= 0, overflow(page))
    check('콘솔 오류 0(첫 로드)', len(console_errors) == 0, console_errors[:3])
    check('페이지 오류 0(첫 로드)', len(page_errors) == 0, page_errors[:3])

    # --- 빈 날짜 셀
    check('기록 없는 날짜 셀에 아이콘 없음',
          page.evaluate("() => document.querySelectorAll('.day .mark, .day img.thumb').length") == 0)

    # --- 월 이동
    title_now = page.locator('#calTitle').inner_text()
    page.click('#prevMonth')
    page.wait_for_timeout(450)
    prev_title = page.locator('#calTitle').inner_text()
    check('‹ 이전 달로 이동', prev_title != title_now, (title_now, prev_title))
    check('이전 달에도 날짜 칸 채워짐', page.locator('.days .day').count() >= 28)
    page.click('#nextMonth')
    page.wait_for_timeout(450)
    check('› 다음 달로 복귀', page.locator('#calTitle').inner_text() == title_now)
    page.click('#nextMonth')
    page.wait_for_timeout(450)
    next_title = page.locator('#calTitle').inner_text()
    check('› 다음 달 표시', next_title != title_now, next_title)
    page.click('#prevMonth')
    page.wait_for_timeout(450)
    check('한 바퀴 돌아 이번 달', page.locator('#calTitle').inner_text() == title_now,
          page.locator('#calTitle').inner_text())
    check('월 이동 후 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.click('#todayBtn')
    page.wait_for_timeout(550)
    check('오늘 버튼으로 이번 달', page.locator('#calTitle').inner_text() == title_now)
    check('오늘 버튼으로 오늘 다시 선택',
          page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)") == [day])

    # --- 다른 날짜를 누르면 아래 카드가 즉시 그 날짜로 바뀐다
    other = shift_key(page, -3)
    if other[:7] != day[:7]:
        other = day[:8] + '01'
    open_day(page, other)
    check('다른 날짜 선택 강조로 이동',
          page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)") == [other])
    check('다른 날짜 → 아래 카드 제목 변경', page.locator('#dayTitle').inner_text().strip() == day_label(other),
          page.locator('#dayTitle').inner_text())
    check('오늘 배지 사라짐', page.locator('#dayPill').is_hidden())
    check('다른 날 안내 문구', '이 날의 발자국이 없어요' in page.locator('#dayEmptyTitle').inner_text())
    check('다른 빈 날에도 바로 쓰는 입력칸', page.locator('#entryForm').is_visible())
    check('날짜 전환 후 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.click('#formCancel')
    page.wait_for_timeout(200)
    check('입력칸 접으면 안내만 남음', page.locator('#entryForm').is_hidden() and page.locator('#dayEmpty').is_visible())
    check('안내에 집/외출 버튼 권유', '집' in page.locator('#dayEmptySub').inner_text())
    page.click('#quickHome')
    page.wait_for_selector('#entryForm:not([hidden])')
    check('빠른 버튼으로 다시 입력칸', page.locator('#entryForm').is_visible())
    open_day(page, day)

    # --- 🏠 집 기록 저장 (달력 아래 카드에서 바로)
    page.fill('#noteInput', '집에서 성경 읽고 플래너 정리했다.')
    page.click('#formSave')
    page.wait_for_selector('.rec')
    page.wait_for_timeout(450)
    check('집 기록 저장됨', '집에서 성경 읽고 플래너' in page.locator('#recList').inner_text())
    check('저장 후 입력칸 닫힘', page.locator('#entryForm').is_hidden())
    check('저장 후 🏠 배지', page.locator('.rec-badge.home').count() == 1)
    check('카드 부제에 기록 수', page.locator('#daySub').inner_text().strip() == '기록 1개',
          page.locator('#daySub').inner_text())
    check('기록 있으면 + 기록 추가 보임', page.locator('#addMoreBtn').is_visible())
    check('빈 안내는 사라짐', page.locator('#dayEmpty').is_hidden())
    check('달력 칸에 🏠', page.locator(f'.day[data-date="{day}"] .mark').inner_text() == '🏠')
    check('사진 썸네일은 아직 없음', page.locator(f'.day[data-date="{day}"] img.thumb').count() == 0)
    check('집 기록 후 가로 넘침 없음', overflow(page) <= 0, overflow(page))

    # 새로고침 후 IndexedDB 유지
    page.reload(wait_until='networkidle')
    page.wait_for_selector('.days .day')
    page.wait_for_timeout(600)
    check('새로고침 후 오늘 다시 선택',
          page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)") == [day])
    check('새로고침 후 🏠 유지', page.locator(f'.day[data-date="{day}"] .mark').inner_text() == '🏠')
    check('새로고침 후 카드에 기록', '성경 읽고' in page.locator('#recList').inner_text())
    check('새로고침 후 입력칸은 닫혀 있음', page.locator('#entryForm').is_hidden())

    # --- 서비스워커(오프라인) 동작
    try:
        page.wait_for_function("() => navigator.serviceWorker.getRegistration().then(r => !!r && !!r.active)", timeout=8000)
        sw_ok = True
    except Exception:
        sw_ok = False
    check('서비스워커 등록·활성화', sw_ok)
    if sw_ok:
        page.context.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.days .day', timeout=8000)
        page.wait_for_timeout(600)
        check('오프라인에서도 화면 열림', page.locator('.cal-card').is_visible())
        check('오프라인에서도 기록 표시', page.locator(f'.day[data-date="{day}"] .mark').inner_text() == '🏠')
        check('오프라인에서도 아래 카드 기록', '성경 읽고' in page.locator('#recList').inner_text())
        page.context.set_offline(False)
        page.reload(wait_until='networkidle')
        page.wait_for_selector('.days .day')
        page.wait_for_timeout(500)
    dump = db_dump(page)
    check('IndexedDB entries 1개', len(dump['entries']) == 1, dump['entries'])
    check('IndexedDB entries 스키마', dump['entries'][0]['kind'] == 'home' and dump['entries'][0]['date'] == day, dump['entries'][0])

    # --- 📍 외출 기록 + 실제 사진 업로드
    page.click('#quickOuting')
    page.wait_for_selector('#entryForm:not([hidden])')
    page.wait_for_timeout(300)
    check('외출 선택 → 장소 칸 보임', page.locator('#placeField').is_visible())
    check('외출 선택 → 사진 칸 보임', page.locator('#photoField').is_visible())
    check('외출 빠른 버튼이 활성', page.locator('#quickOuting').get_attribute('aria-pressed') == 'true')
    check('집 빠른 버튼은 비활성', page.locator('#quickHome').get_attribute('aria-pressed') == 'false')

    chip_texts = page.evaluate("() => [...document.querySelectorAll('#placeChips .chip')].map(c => c.innerText.trim())")
    for name in ['교회', '카페', '장신대', '마트', '산책']:
        check(f'기본 장소 칩 "{name}"', name in chip_texts, chip_texts)

    page.locator('#placeChips .chip', has_text='카페').first.click()
    check('칩 누르면 장소 입력', page.input_value('#placeInput') == '카페')
    page.fill('#placeInput', '연남동 카페')

    page.set_input_files('#albumInput', PHOTO_A)
    page.wait_for_selector('.photo-item img', timeout=15000)
    check('사진 미리보기 1장', page.locator('.photo-item').count() == 1)

    page.fill('#noteInput', '오랜만에 친구랑 커피 마시고 수다.')
    check('저장 전 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.click('#formSave')
    page.wait_for_selector('.rec-badge.outing')
    page.wait_for_timeout(600)
    check('외출 기록 저장됨', '연남동 카페' in page.locator('#recList').inner_text())
    check('카드에 외출 사진 1장', page.locator('.rec-photo').count() == 1)
    check('카드 부제에 사진 수', page.locator('#daySub').inner_text().strip() == '기록 2개 · 사진 1장',
          page.locator('#daySub').inner_text())
    check('달력 칸에 사진 썸네일', page.locator(f'.day[data-date="{day}"] img.thumb').count() == 1)
    thumb_ok = page.evaluate(f"""() => {{
        const img = document.querySelector('.day[data-date="{day}"] img.thumb');
        return !!img && img.naturalWidth > 0 && img.src.startsWith('blob:');
    }}""")
    check('썸네일 실제 이미지 로드', thumb_ok)

    dump = db_dump(page)
    check('IndexedDB photos 1장', len(dump['photos']) == 1, dump['photos'])
    if dump['photos']:
        ph = dump['photos'][0]
        check('원본은 JPEG로 압축 저장', ph['fullType'] == 'image/jpeg', ph['fullType'])
        check('원본 1200px 이하로 압축', 0 < ph['fullSize'] < 900 * 1024, ph['fullSize'])
        check('썸네일 160px 소형 저장', 0 < ph['thumbSize'] < 60 * 1024, ph['thumbSize'])
        check('썸네일이 원본보다 작다', ph['thumbSize'] < ph['fullSize'], (ph['thumbSize'], ph['fullSize']))

    # 새로고침 유지 (사진)
    page.reload(wait_until='networkidle')
    page.wait_for_selector('.days .day')
    page.wait_for_timeout(600)
    check('새로고침 후 사진 썸네일 유지',
          page.locator(f'.day[data-date="{day}"] img.thumb').count() == 1)
    check('새로고침 후 카드 사진 유지', page.locator('.rec-photo').count() == 1)
    dump = db_dump(page)
    check('새로고침 후 기록 2개', len(dump['entries']) == 2, len(dump['entries']))

    # --- + 기록 추가 → 하루 여러 곳 (+N 배지)
    page.click('#addMoreBtn')
    page.wait_for_selector('#entryForm:not([hidden])')
    page.wait_for_timeout(250)
    check('+ 기록 추가로 외출 입력칸', page.locator('#placeField').is_visible())
    page.fill('#placeInput', '교회')
    page.set_input_files('#albumInput', PHOTO_B)
    page.wait_for_selector('.photo-item img', timeout=15000)
    page.fill('#noteInput', '저녁 예배 후 정윤선 디렉터와 내일 일정 이야기.')
    page.click('#formSave')
    page.wait_for_selector('.rec-badge.outing >> nth=1')
    page.wait_for_timeout(600)
    check('같은 날 외출 기록 2개', page.locator('.rec-badge.outing').count() == 2)
    check('같은 날 기록 3개', page.locator('.rec').count() == 3)
    check('카드 부제 3개·사진 2장', page.locator('#daySub').inner_text().strip() == '기록 3개 · 사진 2장')
    check('달력에 +N 배지', page.locator(f'.day[data-date="{day}"] .badge').inner_text() == '+2')
    check('사진 썸네일은 대표 1장', page.locator(f'.day[data-date="{day}"] img.thumb').count() == 1)

    # --- 자주 가는 장소 자동 추천 / 편집
    page.click('#quickOuting')
    page.wait_for_selector('#placeChips .chip')
    page.wait_for_timeout(300)
    chip_texts = page.evaluate("() => [...document.querySelectorAll('#placeChips .chip')].map(c => c.innerText.trim())")
    check('내가 쓴 장소가 칩에 자동 추천', '연남동 카페' in chip_texts, chip_texts)
    page.click('#chipEditBtn')
    check('편집 모드에서 ✕ 표시', '✕' in page.locator('#placeChips .chip').first.inner_text())
    page.locator('#placeChips .chip', has_text='산책').first.click()
    page.wait_for_timeout(400)
    chip_texts = page.evaluate("() => [...document.querySelectorAll('#placeChips .chip')].map(c => c.innerText.trim())")
    check('칩 편집으로 산책 숨김', not any('산책' in c for c in chip_texts), chip_texts)
    page.fill('#chipNewInput', '도서관')
    page.click('#chipAddBtn')
    page.wait_for_timeout(500)
    chip_texts = page.evaluate("() => [...document.querySelectorAll('#placeChips .chip')].map(c => c.innerText.trim())")
    check('새 장소 칩 추가', any('도서관' in c for c in chip_texts), chip_texts)
    check('추가한 칩이 장소에 입력', page.input_value('#placeInput') == '도서관')
    page.click('#formCancel')
    page.wait_for_timeout(250)
    prefs = db_dump(page)['settings']
    chip_pref = next((s['value'] for s in prefs if s['key'] == 'chipPrefs'), {})
    check('칩 설정이 저장됨', '산책' in chip_pref.get('hidden', []) and '도서관' in chip_pref.get('custom', []), chip_pref)

    # --- 수정
    target = page.locator('.rec', has_text='저녁 예배').first
    target.locator('[data-act="edit"]').click()
    page.wait_for_selector('#entryForm:not([hidden])')
    page.wait_for_timeout(350)
    check('수정 시 장소 채워짐', page.input_value('#placeInput') == '교회')
    check('수정 시 내용 채워짐', '정윤선' in page.input_value('#noteInput'))
    check('수정 시 기존 사진 보임', page.locator('.photo-item').count() == 1)
    check('수정 표시가 폼 위에 보임', page.locator('#formTitle').is_visible()
          and '교회' in page.locator('#formTitle').inner_text())
    check('버튼이 수정 완료', page.locator('#formSave').inner_text().strip() == '수정 완료')
    page.fill('#placeInput', '고양동 교회')
    page.fill('#noteInput', '저녁 예배 후 내일 일정 이야기.')
    page.click('#formSave')
    page.wait_for_timeout(800)
    check('수정 반영됨', '고양동 교회' in page.locator('#recList').inner_text())
    check('수정 후에도 기록 3개', page.locator('.rec').count() == 3)
    check('수정 후 입력칸 닫힘', page.locator('#entryForm').is_hidden())
    dump = db_dump(page)
    check('수정 후 photos 2장 그대로', len(dump['photos']) == 2, len(dump['photos']))

    # --- 라이트박스(카드 사진 썸네일 클릭)
    page.locator('.rec', has_text='연남동 카페').first.locator('.rec-photo').first.click()
    page.wait_for_selector('#lightbox:not([hidden])')
    page.wait_for_function("() => { const i = document.querySelector('#lbImg'); return i && i.complete && i.naturalWidth > 0; }", timeout=5000)
    lb_ok = page.evaluate("() => { const i = document.querySelector('#lbImg'); return i.src.startsWith('blob:') && i.naturalWidth > 0; }")
    check('카드 사진 클릭 → 큰 화면 보기', lb_ok)
    page.click('#lbClose')
    page.wait_for_timeout(200)
    check('라이트박스 닫힘', page.locator('#lightbox').is_hidden())

    # --- 삭제
    page.locator('.rec', has_text='연남동 카페').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    check('삭제 확인 대화상자', '삭제' in page.locator('#dialogText').inner_text())
    page.click('#dialogCancel')
    page.wait_for_timeout(300)
    check('취소하면 그대로', page.locator('.rec').count() == 3)
    page.locator('.rec', has_text='연남동 카페').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    page.click('#dialogOk')
    page.wait_for_timeout(900)
    check('삭제 후 기록 2개', page.locator('.rec').count() == 2, page.locator('.rec').count())
    check('삭제 후 입력칸 안 열림', page.locator('#entryForm').is_hidden())
    dump = db_dump(page)
    check('삭제 시 사진도 함께 삭제', len(dump['photos']) == 1, dump['photos'])
    check('삭제 후 배지 +1', page.locator(f'.day[data-date="{day}"] .badge').inner_text() == '+1')

    # --- 외출 → 집으로 종류를 바꾸면 사진은 정리된다
    page.click('#addMoreBtn')
    page.wait_for_selector('#entryForm:not([hidden])')
    page.fill('#placeInput', '테스트 장소')
    page.set_input_files('#albumInput', PHOTO_B)
    page.wait_for_selector('.photo-item img', timeout=15000)
    page.fill('#noteInput', '종류 바꾸기 테스트')
    page.click('#formSave')
    page.wait_for_timeout(900)
    check('임시 외출 기록 저장', '테스트 장소' in page.locator('#recList').inner_text())
    dump = db_dump(page)
    check('임시 사진 2장', len(dump['photos']) == 2, len(dump['photos']))
    page.locator('.rec', has_text='테스트 장소').first.locator('[data-act="edit"]').click()
    page.wait_for_selector('#entryForm:not([hidden])')
    page.click('#quickHome')
    page.wait_for_timeout(400)
    check('수정 중 집으로 바꾸면 장소·사진 칸 숨김',
          page.locator('#placeField').is_hidden() and page.locator('#photoField').is_hidden())
    check('종류를 바꿔도 내용은 남음', '테스트' in page.input_value('#noteInput'))
    page.fill('#noteInput', '집에서 푹 쉬었다.')
    page.click('#formSave')
    page.wait_for_timeout(1000)
    dump = db_dump(page)
    check('집으로 바꾸면 사진 삭제', len(dump['photos']) == 1, len(dump['photos']))
    check('집 기록으로 바뀜', page.locator('.rec-badge.home').count() >= 2, page.locator('.rec-badge.home').count())
    page.locator('.rec', has_text='집에서 푹 쉬었다').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    page.click('#dialogOk')
    page.wait_for_timeout(1000)
    check('임시 기록 정리 후 2개', page.locator('.rec').count() == 2, page.locator('.rec').count())

    # --- 검색 (장소 / 내용) → 그 날짜가 선택되고 아래 카드로
    page.click('#searchBtn')
    page.wait_for_selector('#searchOverlay:not([hidden])')
    page.wait_for_timeout(300)
    check('검색 안내 문구', '검색' in page.locator('#searchHint').inner_text())
    page.fill('#searchInput', '교회')
    page.wait_for_timeout(400)
    check('장소 검색 결과 있음', page.locator('.sres').count() >= 1, page.locator('.sres').count())
    check('검색 결과에 날짜 표시', '월' in page.locator('.sres .sres-date').first.inner_text())
    page.fill('#searchInput', '성경 읽고')
    page.wait_for_timeout(400)
    check('내용 검색 결과 있음', page.locator('.sres').count() == 1, page.locator('.sres').count())
    check('검색어 하이라이트', page.locator('.sres mark').count() >= 1)
    check('검색 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.evaluate("() => window.scrollTo(0, 0)")
    page.locator('.sres').first.click()
    page.wait_for_selector('#searchOverlay[hidden]', state='attached')
    page.wait_for_timeout(900)
    check('검색 결과 클릭 → 그 날짜 선택',
          page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)") == [day],
          page.evaluate("() => [...document.querySelectorAll('.day.selected')].map(e => e.dataset.date)"))
    check('검색 결과 클릭 → 아래 카드 그 날짜', page.locator('#dayTitle').inner_text().strip() == day_label(day))
    check('검색 결과 클릭 → 아래 카드로 스크롤', page.evaluate("() => window.scrollY") > 0,
          page.evaluate("() => window.scrollY"))
    check('검색 결과 클릭 → 기록 강조', page.locator('.rec.flash').count() == 1)

    # --- 백업 내보내기 (기록 2개 / 사진 1장 상태)
    page.click('#backupBtn')
    page.wait_for_selector('#backupBackdrop:not([hidden])')
    storage_text = page.locator('#storageInfo').inner_text()
    check('백업 시트에 저장 현황', '기록' in storage_text and '사진' in storage_text, storage_text)
    backup_path = os.path.join(SHOTS, 'backup.json')
    with page.expect_download() as dl:
        page.click('#exportBtn')
    download = dl.value
    download.save_as(backup_path)
    check('JSON 내보내기 파일 생성', os.path.exists(backup_path))
    with open(backup_path, encoding='utf-8') as f:
        backup = json.load(f)
    check('백업 app 표시', backup.get('app') == 'place-diary')
    check('백업에 기록 2개', len(backup.get('entries', [])) == 2, len(backup.get('entries', [])))
    pics = [p for e in backup['entries'] for p in e.get('photos', [])]
    check('백업에 사진 1장 포함', len(pics) == 1, len(pics))
    check('백업 사진은 dataURL', all(p['full'].startswith('data:image/jpeg;base64,') for p in pics))
    check('백업 파일 저장 링크 제공', page.locator('#exportLink').is_visible()
          and page.locator('#exportLink').get_attribute('download').endswith('.json'))
    page.click('#backupClose')
    page.wait_for_timeout(300)

    # --- 스크린샷용으로 이번 달 다른 날들도 채우기
    seed_days = page.evaluate("""() => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const key = (t) => t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
        const out = [];
        for (const back of [9, 7, 5, 3]) {
            const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
            if (t.getMonth() === d.getMonth() && t.getDate() >= 1) out.push(key(t));
        }
        return out;
    }""")
    check('스크린샷용 날짜 확보', len(seed_days) >= 2, seed_days)

    def add_record(key, kind, note, place=None, photo=None):
        open_day(page, key)
        page.wait_for_selector('#entryForm:not([hidden])')
        if kind == 'outing':
            page.click('#quickOuting')
            page.wait_for_timeout(250)
        if place:
            page.fill('#placeInput', place)
        if photo:
            page.set_input_files('#albumInput', photo)
            page.wait_for_selector('.photo-item img', timeout=15000)
        page.fill('#noteInput', note)
        page.click('#formSave')
        page.wait_for_timeout(800)

    if len(seed_days) >= 4:
        add_record(seed_days[0], 'home', '집에서 설교 준비하고 책 읽었다.')
        add_record(seed_days[1], 'outing', '점심 먹고 한강까지 걸었다.', place='한강공원', photo=PHOTO_B)
        add_record(seed_days[2], 'home', '아이들과 놀이터 다녀왔다.')
        add_record(seed_days[3], 'outing', '장신대 도서관에서 공부.', place='장신대')
        marks = page.evaluate("() => [...document.querySelectorAll('.day .mark')].map(e => e.textContent)")
        check('달력에 🏠/📍 표시', marks.count('🏠') >= 2 and marks.count('📍') >= 1, marks)

    # --- 대표 스크린샷 1: 달력 + 오늘의 기록 카드
    open_day(page, day)
    page.evaluate("() => { window.scrollTo(0, 0); const t = document.getElementById('toast'); if (t) t.hidden = true; }")
    page.wait_for_timeout(700)
    shot1 = save_shot(page, '01_calendar_390.png')
    save_shot(page, '01_calendar_390.png', REPO_SHOTS)
    check('스크린샷 01_calendar_390.png 저장', os.path.exists(shot1))
    shot_info = page.evaluate("""() => {
        const c = document.querySelector('.cal-card').getBoundingClientRect();
        const d = document.querySelector('#dayCard').getBoundingClientRect();
        return { calBottom: Math.round(c.bottom), dayTop: Math.round(d.top),
                 recs: document.querySelectorAll('#dayCard .rec').length,
                 photos: document.querySelectorAll('#dayCard .rec-photo').length };
    }""")
    check('스크린샷에 달력 + 오늘 기록 카드 함께', shot_info['calBottom'] < 844 and shot_info['recs'] >= 2, shot_info)
    check('오늘 카드에 사진 썸네일', shot_info['photos'] >= 1, shot_info)

    # --- 대표 스크린샷 2: 빈 날에 바로 적는 외출 입력칸
    blank = shift_key(page, -1)
    if blank[:7] != day[:7]:
        blank = day[:8] + '02' if day[8:10] != '01' else day[:8] + '03'
    if page.locator(f'.day[data-date="{blank}"] .mark, .day[data-date="{blank}"] img.thumb').count() == 0:
        open_day(page, blank)
        page.click('#quickOuting')
        page.wait_for_selector('#entryForm:not([hidden])')
        page.wait_for_timeout(500)
        page.evaluate("() => { document.activeElement && document.activeElement.blur(); const t = document.getElementById('toast'); if (t) t.hidden = true; }")
        page.wait_for_timeout(300)
        shot2 = save_shot(page, '02_compose_390.png')
        save_shot(page, '02_compose_390.png', REPO_SHOTS)
        check('스크린샷 02_compose_390.png 저장', os.path.exists(shot2))
        check('외출 입력칸 가로 넘침 없음', overflow(page) <= 0, overflow(page))
        page.click('#formCancel')
        page.wait_for_timeout(200)

    check('콘솔 오류 0(모바일 전체)', len(console_errors) == 0, console_errors[:5])
    check('페이지 오류 0(모바일 전체)', len(page_errors) == 0, page_errors[:5])
    check('가로 넘침 없음(모바일 최종)', overflow(page) <= 0, overflow(page))
    ctx.close()

    # ============================================================ JSON 불러오기 (빈 저장공간)
    ctx2, page2, console2, pageerr2, failed2 = new_page(browser, 390, 844)
    page2.goto(BASE, wait_until='networkidle')
    page2.wait_for_selector('.days .day')
    page2.wait_for_timeout(600)
    check('새 저장공간은 비어 있음',
          page2.evaluate("() => document.querySelectorAll('.day .mark, .day img.thumb').length") == 0)
    page2.click('#backupBtn')
    page2.set_input_files('#importInput', backup_path)
    page2.wait_for_timeout(2000)
    dump2 = db_dump(page2)
    check('불러오기 후 기록 2개', len(dump2['entries']) == 2, len(dump2['entries']))
    check('불러오기 후 사진 1장', len(dump2['photos']) == 1, len(dump2['photos']))
    page2.click('#backupClose')
    page2.wait_for_timeout(900)
    day2 = today_key(page2)
    check('불러온 기록이 달력에 표시', page2.locator('.days img.thumb, .days .mark').count() >= 1)
    check('불러온 사진 썸네일 표시', page2.locator(f'.day[data-date="{day2}"] img.thumb').count() == 1)
    check('불러온 기록이 아래 카드에 표시', '성경 읽고' in page2.locator('#recList').inner_text())
    check('불러온 뒤 카드 부제 2개', '기록 2개' in page2.locator('#daySub').inner_text(),
          page2.locator('#daySub').inner_text())
    page2.locator('.rec', has_text='고양동 교회').first.locator('.rec-photo').first.click()
    page2.wait_for_selector('#lightbox:not([hidden])')
    page2.wait_for_timeout(400)
    check('불러온 사진도 크게 보기', page2.evaluate("() => { const i=document.querySelector('#lbImg'); return !!i && i.naturalWidth>0; }"))
    page2.click('#lbClose')
    check('콘솔 오류 0(불러오기)', len(console2) == 0, console2[:5])
    check('페이지 오류 0(불러오기)', len(pageerr2) == 0, pageerr2[:5])
    ctx2.close()

    # ============================================================ PC 1280×800
    ctx3, page3, console3, pageerr3, _ = new_page(browser, 1280, 800, mobile=False)
    page3.goto(BASE, wait_until='networkidle')
    page3.wait_for_selector('.days .day')
    page3.wait_for_timeout(600)
    check('PC 가로 넘침 없음', overflow(page3) <= 0, overflow(page3))
    check('PC에서 달력 보임', page3.locator('.cal-card').is_visible())
    check('PC에서 오늘 카드 보임', page3.locator('#dayCard').is_visible())
    card_w = page3.evaluate("() => Math.round(document.querySelector('.cal-card').getBoundingClientRect().width)")
    check('PC에서는 가운데 좁은 카드', 380 <= card_w <= 500, card_w)
    day3 = today_key(page3)
    check('PC에서도 오늘 선택', page3.locator('.day.selected').get_attribute('data-date') == day3)
    page3.click('#quickOuting')
    page3.wait_for_selector('#entryForm:not([hidden])')
    page3.wait_for_timeout(300)
    check('PC에서 외출 폼 열림', page3.locator('#photoField').is_visible())
    check('PC 카드 가로 넘침 없음', overflow(page3) <= 0, overflow(page3))
    page3.fill('#placeInput', '연남동 카페')
    page3.fill('#noteInput', '친구랑 커피 한 잔.')
    page3.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    page3.evaluate("() => window.scrollTo(0, 0)")
    page3.wait_for_timeout(500)
    save_shot(page3, '03_pc_1280.png')
    page3.click('#formCancel')
    page3.wait_for_timeout(200)
    page3.click('#searchBtn')
    page3.wait_for_selector('#searchOverlay:not([hidden])')
    check('PC 검색 화면 넘침 없음', overflow(page3) <= 0, overflow(page3))
    page3.click('#searchClose')
    check('콘솔 오류 0(PC)', len(console3) == 0, console3[:5])
    check('페이지 오류 0(PC)', len(pageerr3) == 0, pageerr3[:5])
    ctx3.close()

    browser.close()

print('\n================ 결과 ================')
print('통과 %d / 실패 %d' % (len(PASSES), len(FAILS)))
if FAILS:
    for f in FAILS:
        print(' - ' + f)
    raise SystemExit(1)
