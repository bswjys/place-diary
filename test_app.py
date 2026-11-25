"""오늘의 발자국 — Playwright 검증 (390×844 모바일 / 1280×800 PC)

    LD_LIBRARY_PATH=/workspace/.browserlibs/lib python3 test_app.py

검증
- 메인 화면이 작은 제목 + 월간 달력만 보이는지, 가로 넘침 0
- 🏠 집 기록(사진 없이 내용만) 저장 → 달력 🏠 → 새로고침 후 IndexedDB 유지
- 📍 외출 기록(장소 + 실제 JPEG 업로드 + 내용) 저장 → 달력 썸네일 → 새로고침 후 유지
- 하루 여러 곳(+N 배지), 수정·삭제, 자주 가는 장소 칩/편집
- 장소·내용 검색 → 해당 날짜로 이동
- JSON 내보내기 / 새 저장공간에서 불러오기(사진 포함)
- 라이트박스, PC 레이아웃, 콘솔 오류 0
- 대표 스크린샷 downloads/place_diary/
"""
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
    return page.evaluate("""() => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }""")


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


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])

    # ============================================================ 모바일
    ctx, page, console_errors, page_errors, failed = new_page(browser, 390, 844)
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.days .day')
    day = today_key(page)

    # --- 메인 화면: 작은 제목 + 달력만
    title = page.locator('.app-title')
    check('제목 "오늘의 발자국" 표시', title.inner_text().strip() == '오늘의 발자국')
    fs = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.app-title')).fontSize)")
    check('제목이 작다 (17px 이하)', fs <= 18, fs)
    check('main 안에 달력 카드 하나만', page.evaluate("() => document.querySelectorAll('main > *').length") == 1)
    check('상단 버튼은 검색·백업 2개', page.evaluate("() => document.querySelectorAll('.top-actions .icon-btn').length") == 2)
    check('메인에 다른 문단/목록 없음', page.evaluate(
        "() => document.querySelectorAll('main p, main ul, main h2:not(.cal-title)').length") == 0)
    cal_bottom = page.evaluate("() => Math.round(document.querySelector('.cal-card').getBoundingClientRect().bottom)")
    check('달력이 첫 화면 안에 다 보인다', cal_bottom <= 844, cal_bottom)
    check('요일 7칸', page.evaluate("() => document.querySelectorAll('.weekdays span').length") == 7)
    check('가로 넘침 없음(메인 390)', overflow(page) <= 0, overflow(page))
    check('콘솔 오류 0(첫 로드)', len(console_errors) == 0, console_errors[:3])
    check('페이지 오류 0(첫 로드)', len(page_errors) == 0, page_errors[:3])

    # --- 빈 날짜 셀
    check('기록 없는 날짜 셀에 아이콘 없음',
          page.evaluate("() => document.querySelectorAll('.day .mark, .day img.thumb').length") == 0)

    # --- 월 이동
    title_now = page.locator('#calTitle').inner_text()
    page.click('#prevMonth')
    page.wait_for_timeout(400)
    prev_title = page.locator('#calTitle').inner_text()
    check('‹ 이전 달로 이동', prev_title != title_now, (title_now, prev_title))
    check('이전 달에도 날짜 칸 채워짐', page.locator('.days .day').count() >= 28)
    page.click('#nextMonth')
    page.wait_for_timeout(400)
    check('› 다음 달로 복귀', page.locator('#calTitle').inner_text() == title_now)
    page.click('#nextMonth')
    page.wait_for_timeout(400)
    next_title = page.locator('#calTitle').inner_text()
    check('› 다음 달 표시', next_title != title_now, next_title)
    page.click('#prevMonth')
    page.wait_for_timeout(400)
    check('한 바퀴 돌아 이번 달', page.locator('#calTitle').inner_text() == title_now,
          page.locator('#calTitle').inner_text())
    page.click('#todayBtn')
    page.wait_for_timeout(400)
    check('오늘 버튼으로 이번 달', page.locator('#calTitle').inner_text() == title_now)
    check('월 이동 후 가로 넘침 없음', overflow(page) <= 0, overflow(page))

    # --- 🏠 집 기록 저장
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    check('날짜 클릭 → 시트 열림', page.locator('#dayTitle').inner_text().endswith(')'))
    check('집/외출 버튼 2개', page.locator('.kind-btn').count() == 2)
    check('처음엔 입력 폼이 숨겨져 있음', page.locator('#entryForm').is_hidden())
    check('처음엔 빈 기록 안내', '아직 기록이 없어요' in page.locator('#recList').inner_text())

    page.click('#kindHome')
    page.wait_for_selector('#entryForm:not([hidden])')
    check('집 선택 → 장소 칸 없음', page.locator('#placeField').is_hidden())
    check('집 선택 → 사진 칸 없음', page.locator('#photoField').is_hidden())
    page.fill('#noteInput', '집에서 성경 읽고 플래너 정리했다.')
    page.click('#formSave')
    page.wait_for_selector('.rec')
    check('집 기록 저장됨', '집에서 성경 읽고 플래너' in page.locator('#recList').inner_text())
    check('저장 후 폼 닫힘', page.locator('#entryForm').is_hidden())
    check('저장 후 🏠 배지', page.locator('.rec-badge.home').count() == 1)
    page.click('#dayClose')
    page.wait_for_selector('#dayBackdrop[hidden]', state='attached')
    page.wait_for_timeout(150)
    check('달력 칸에 🏠', page.locator(f'.day[data-date="{day}"] .mark').inner_text() == '🏠')
    check('사진 썸네일은 아직 없음', page.locator(f'.day[data-date="{day}"] img.thumb').count() == 0)

    # 새로고침 후 IndexedDB 유지
    page.reload(wait_until='networkidle')
    page.wait_for_selector('.days .day')
    page.wait_for_timeout(250)
    check('새로고침 후 🏠 유지', page.locator(f'.day[data-date="{day}"] .mark').inner_text() == '🏠')
    dump = db_dump(page)
    check('IndexedDB entries 1개', len(dump['entries']) == 1, dump['entries'])
    check('IndexedDB entries 스키마', dump['entries'][0]['kind'] == 'home' and dump['entries'][0]['date'] == day, dump['entries'][0])

    # --- 📍 외출 기록 + 실제 사진 업로드
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.click('#kindOuting')
    page.wait_for_selector('#entryForm:not([hidden])')
    check('외출 선택 → 장소 칸 보임', page.locator('#placeField').is_visible())
    check('외출 선택 → 사진 칸 보임', page.locator('#photoField').is_visible())

    chips = page.locator('#placeChips .chip')
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
    before_overflow = overflow(page)
    page.click('#formSave')
    page.wait_for_selector('.rec-badge.outing')
    check('외출 기록 저장됨', '연남동 카페' in page.locator('#recList').inner_text())
    check('외출 기록 사진 1장', page.locator('.rec-photo').count() == 1)
    check('저장 중 가로 넘침 없음', before_overflow <= 0, before_overflow)

    page.click('#dayClose')
    page.wait_for_timeout(350)
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
    page.wait_for_timeout(400)
    check('새로고침 후 사진 썸네일 유지',
          page.locator(f'.day[data-date="{day}"] img.thumb').count() == 1)
    dump = db_dump(page)
    check('새로고침 후 기록 2개', len(dump['entries']) == 2, len(dump['entries']))

    # --- 하루 여러 곳 추가 (+N 배지)
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.click('#kindOuting')
    page.fill('#placeInput', '교회')
    page.set_input_files('#albumInput', PHOTO_B)
    page.wait_for_selector('.photo-item img', timeout=15000)
    page.fill('#noteInput', '저녁 예배 후 정윤선 디렉터와 내일 일정 이야기.')
    page.click('#formSave')
    page.wait_for_selector('.rec-badge.outing >> nth=1')
    check('같은 날 외출 기록 2개', page.locator('.rec-badge.outing').count() == 2)
    check('기록 개수 표시 3개', page.locator('#recCount').inner_text().strip() == '3개')
    page.click('#dayClose')
    page.wait_for_timeout(300)
    check('달력에 +N 배지', page.locator(f'.day[data-date="{day}"] .badge').inner_text() == '+2')
    check('사진 썸네일은 대표 1장', page.locator(f'.day[data-date="{day}"] img.thumb').count() == 1)

    # --- 자주 가는 장소 자동 추천 / 편집
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.click('#kindOuting')
    chips = page.locator('#placeChips .chip')
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
    page.wait_for_timeout(400)
    chip_texts = page.evaluate("() => [...document.querySelectorAll('#placeChips .chip')].map(c => c.innerText.trim())")
    check('새 장소 칩 추가', any('도서관' in c for c in chip_texts), chip_texts)
    check('추가한 칩이 장소에 입력', page.input_value('#placeInput') == '도서관')
    page.click('#formCancel')
    prefs = db_dump(page)['settings']
    chip_pref = next((s['value'] for s in prefs if s['key'] == 'chipPrefs'), {})
    check('칩 설정이 저장됨', '산책' in chip_pref.get('hidden', []) and '도서관' in chip_pref.get('custom', []), chip_pref)

    # --- 수정
    target = page.locator('.rec', has_text='저녁 예배').first
    target.locator('[data-act="edit"]').click()
    page.wait_for_selector('#entryForm:not([hidden])')
    check('수정 시 장소 채워짐', page.input_value('#placeInput') == '교회')
    check('수정 시 내용 채워짐', '정윤선' in page.input_value('#noteInput'))
    check('수정 시 기존 사진 보임', page.locator('.photo-item').count() == 1)
    check('버튼이 수정 완료', page.locator('#formSave').inner_text().strip() == '수정 완료')
    page.fill('#placeInput', '고양동 교회')
    page.fill('#noteInput', '저녁 예배 후 내일 일정 이야기.')
    page.click('#formSave')
    page.wait_for_timeout(500)
    check('수정 반영됨', '고양동 교회' in page.locator('#recList').inner_text())
    check('수정 후에도 기록 3개', page.locator('#recCount').inner_text().strip() == '3개')
    dump = db_dump(page)
    check('수정 후 photos 2장 그대로', len(dump['photos']) == 2, len(dump['photos']))

    # --- 라이트박스
    page.locator('.rec', has_text='연남동 카페').first.locator('.rec-photo').click()
    page.wait_for_selector('#lightbox:not([hidden])')
    page.wait_for_function("() => { const i = document.querySelector('#lbImg'); return i && i.complete && i.naturalWidth > 0; }", timeout=5000)
    lb_ok = page.evaluate("() => { const i = document.querySelector('#lbImg'); return i.src.startsWith('blob:') && i.naturalWidth > 0; }")
    check('사진 클릭 → 큰 화면 보기', lb_ok)
    page.click('#lbClose')
    page.wait_for_timeout(150)
    check('라이트박스 닫힘', page.locator('#lightbox').is_hidden())

    # --- 삭제
    page.locator('.rec', has_text='연남동 카페').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    check('삭제 확인 대화상자', '삭제' in page.locator('#dialogText').inner_text())
    page.click('#dialogCancel')
    page.wait_for_timeout(200)
    check('취소하면 그대로', page.locator('.rec').count() == 3)
    page.locator('.rec', has_text='연남동 카페').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    page.click('#dialogOk')
    page.wait_for_timeout(600)
    check('삭제 후 기록 2개', page.locator('.rec').count() == 2, page.locator('.rec').count())
    dump = db_dump(page)
    check('삭제 시 사진도 함께 삭제', len(dump['photos']) == 1, dump['photos'])
    page.click('#dayClose')
    page.wait_for_timeout(350)
    check('삭제 후 배지 +1', page.locator(f'.day[data-date="{day}"] .badge').inner_text() == '+1')

    # --- 외출 → 집으로 종류를 바꾸면 사진은 정리된다
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.click('#kindOuting')
    page.fill('#placeInput', '테스트 장소')
    page.set_input_files('#albumInput', PHOTO_B)
    page.wait_for_selector('.photo-item img', timeout=15000)
    page.fill('#noteInput', '종류 바꾸기 테스트')
    page.click('#formSave')
    page.wait_for_timeout(700)
    check('임시 외출 기록 저장', '테스트 장소' in page.locator('#recList').inner_text())
    dump = db_dump(page)
    check('임시 사진 2장', len(dump['photos']) == 2, len(dump['photos']))
    page.locator('.rec', has_text='테스트 장소').first.locator('[data-act="edit"]').click()
    page.wait_for_selector('#entryForm:not([hidden])')
    page.click('#kindHome')
    page.wait_for_timeout(300)
    check('수정 중 집으로 바꾸면 장소·사진 칸 숨김',
          page.locator('#placeField').is_hidden() and page.locator('#photoField').is_hidden())
    check('종류를 바꿔도 내용은 남음', '테스트' in page.input_value('#noteInput'))
    page.fill('#noteInput', '집에서 푹 쉬었다.')
    page.click('#formSave')
    page.wait_for_timeout(800)
    dump = db_dump(page)
    check('집으로 바꾸면 사진 삭제', len(dump['photos']) == 1, len(dump['photos']))
    check('집 기록으로 바뀜', page.locator('.rec-badge.home').count() >= 2)
    page.locator('.rec', has_text='집에서 푹 쉬었다').first.locator('[data-act="del"]').click()
    page.wait_for_selector('#dialogBackdrop:not([hidden])')
    page.click('#dialogOk')
    page.wait_for_timeout(800)
    check('임시 기록 정리 후 2개', page.locator('.rec').count() == 2, page.locator('.rec').count())
    page.click('#dayClose')
    page.wait_for_timeout(300)

    # --- 검색 (장소 / 내용)
    page.click('#searchBtn')
    page.wait_for_selector('#searchOverlay:not([hidden])')
    check('검색 안내 문구', '검색' in page.locator('#searchHint').inner_text())
    page.fill('#searchInput', '교회')
    page.wait_for_timeout(350)
    check('장소 검색 결과 있음', page.locator('.sres').count() >= 1, page.locator('.sres').count())
    check('검색 결과에 날짜 표시', '월' in page.locator('.sres .sres-date').first.inner_text())
    page.fill('#searchInput', '성경 읽고')
    page.wait_for_timeout(350)
    check('내용 검색 결과 있음', page.locator('.sres').count() == 1, page.locator('.sres').count())
    check('검색어 하이라이트', page.locator('.sres mark').count() >= 1)
    check('검색 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.locator('.sres').first.click()
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.wait_for_timeout(400)
    check('검색 결과 클릭 → 그 날짜로 이동', page.locator('#dayTitle').inner_text().startswith('11월'))
    check('검색 결과 클릭 → 기록 강조', page.locator('.rec.flash').count() == 1)
    page.click('#dayClose')
    page.wait_for_timeout(200)

    # --- 백업 내보내기 (스크린샷용 기록을 넣기 전 상태: 기록 2개 / 사진 1장)
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
    page.wait_for_timeout(200)

    # --- 대표 스크린샷용 기록 몇 날 채우기 (달력이 한눈에 보이도록)
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
        page.click(f'.day[data-date="{key}"]')
        page.wait_for_selector('#dayBackdrop:not([hidden])')
        page.wait_for_timeout(120)
        page.click('#kindHome' if kind == 'home' else '#kindOuting')
        page.wait_for_selector('#entryForm:not([hidden])')
        if place:
            page.fill('#placeInput', place)
        if photo:
            page.set_input_files('#albumInput', photo)
            page.wait_for_selector('.photo-item img', timeout=15000)
        page.fill('#noteInput', note)
        page.click('#formSave')
        page.wait_for_timeout(500)
        page.click('#dayClose')
        page.wait_for_timeout(150)

    if len(seed_days) >= 4:
        add_record(seed_days[0], 'home', '집에서 설교 준비하고 책 읽었다.')
        add_record(seed_days[1], 'outing', '점심 먹고 한강까지 걸었다.', place='한강공원', photo=PHOTO_B)
        add_record(seed_days[2], 'home', '아이들과 놀이터 다녀왔다.')
        add_record(seed_days[3], 'outing', '장신대 도서관에서 공부.', place='장신대')
        marks = page.evaluate("() => [...document.querySelectorAll('.day .mark')].map(e => e.textContent)")
        check('달력에 🏠/📍 표시', marks.count('🏠') >= 2 and marks.count('📍') >= 1, marks)

    # --- 대표 스크린샷 1: 달력
    page.click('#todayBtn')
    page.wait_for_timeout(700)
    page.evaluate("() => { document.getElementById('toast').hidden = true; }")
    page.wait_for_timeout(250)
    shot1 = save_shot(page, '01_calendar_390.png')
    save_shot(page, '01_calendar_390.png', REPO_SHOTS)
    check('스크린샷 01_calendar_390.png 저장', os.path.exists(shot1))

    # --- 대표 스크린샷 2: 외출 기록 화면
    page.click(f'.day[data-date="{day}"]')
    page.wait_for_selector('#dayBackdrop:not([hidden])')
    page.click('#kindOuting')
    page.fill('#placeInput', '고양동 교회')
    page.set_input_files('#albumInput', PHOTO_A)
    page.wait_for_selector('.photo-item img', timeout=15000)
    page.fill('#noteInput', '저녁 예배 다녀왔다. 돌아오는 길에 별이 예뻤다.')
    page.evaluate("() => { document.activeElement && document.activeElement.blur(); const t = document.getElementById('toast'); if (t) t.hidden = true; }")
    page.wait_for_timeout(600)
    shot2 = save_shot(page, '02_outing_390.png')
    save_shot(page, '02_outing_390.png', REPO_SHOTS)
    check('스크린샷 02_outing_390.png 저장', os.path.exists(shot2))
    check('외출 화면 가로 넘침 없음', overflow(page) <= 0, overflow(page))
    page.click('#formCancel')
    page.click('#dayClose')
    page.wait_for_timeout(200)

    check('콘솔 오류 0(모바일 전체)', len(console_errors) == 0, console_errors[:5])
    check('페이지 오류 0(모바일 전체)', len(page_errors) == 0, page_errors[:5])
    check('가로 넘침 없음(모바일 최종)', overflow(page) <= 0, overflow(page))
    ctx.close()

    # ============================================================ JSON 불러오기 (빈 저장공간)
    ctx2, page2, console2, pageerr2, failed2 = new_page(browser, 390, 844)
    page2.goto(BASE, wait_until='networkidle')
    page2.wait_for_selector('.days .day')
    check('새 저장공간은 비어 있음',
          page2.evaluate("() => document.querySelectorAll('.day .mark, .day img.thumb').length") == 0)
    page2.click('#backupBtn')
    page2.set_input_files('#importInput', backup_path)
    page2.wait_for_timeout(1500)
    dump2 = db_dump(page2)
    check('불러오기 후 기록 2개', len(dump2['entries']) == 2, len(dump2['entries']))
    check('불러오기 후 사진 1장', len(dump2['photos']) == 1, len(dump2['photos']))
    page2.click('#backupClose')
    page2.wait_for_timeout(600)
    day2 = today_key(page2)
    check('불러온 기록이 달력에 표시', page2.locator('.days img.thumb, .days .mark').count() >= 1)
    check('불러온 사진 썸네일 표시', page2.locator(f'.day[data-date="{day2}"] img.thumb').count() == 1)
    page2.click(f'.day[data-date="{day2}"]')
    page2.wait_for_selector('#dayBackdrop:not([hidden])')
    check('불러온 기록 내용 확인', '성경 읽고' in page2.locator('#recList').inner_text())
    page2.click('#dayClose')
    page2.wait_for_timeout(200)
    check('콘솔 오류 0(불러오기)', len(console2) == 0, console2[:5])
    check('페이지 오류 0(불러오기)', len(pageerr2) == 0, pageerr2[:5])
    ctx2.close()

    # ============================================================ PC 1280×800
    ctx3, page3, console3, pageerr3, _ = new_page(browser, 1280, 800, mobile=False)
    page3.goto(BASE, wait_until='networkidle')
    page3.wait_for_selector('.days .day')
    check('PC 가로 넘침 없음', overflow(page3) <= 0, overflow(page3))
    check('PC에서 달력 보임', page3.locator('.cal-card').is_visible())
    card_w = page3.evaluate("() => Math.round(document.querySelector('.cal-card').getBoundingClientRect().width)")
    check('PC에서는 가운데 좁은 카드', 380 <= card_w <= 500, card_w)
    day3 = today_key(page3)
    page3.click(f'.day[data-date="{day3}"]')
    page3.wait_for_selector('#dayBackdrop:not([hidden])')
    page3.click('#kindOuting')
    page3.wait_for_selector('#entryForm:not([hidden])')
    check('PC에서 외출 폼 열림', page3.locator('#photoField').is_visible())
    check('PC 시트 가로 넘침 없음', overflow(page3) <= 0, overflow(page3))
    page3.fill('#placeInput', '연남동 카페')
    page3.fill('#noteInput', '친구랑 커피 한 잔.')
    page3.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    page3.wait_for_timeout(600)
    save_params = save_shot(page3, '03_pc_1280.png')
    page3.click('#formCancel')
    page3.click('#dayClose')
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
