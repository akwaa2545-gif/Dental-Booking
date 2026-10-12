# ToothTalk · Dental Booking

ระบบนัดหมายทันตกรรมภาษาไทย มีหน้าเดโม และ runtime สำหรับทดสอบการนัดหมายผ่าน LINE LIFF พร้อมหน้าแอดมินและการแจ้งเตือน

> **สถานะของ repository:** ชุด source ที่กู้คืนและประกอบใหม่จาก source รุ่นที่ยังอยู่ เทียบกับโปรแกรมที่ deploy และ migration history ไม่ใช่สำเนา byte-for-byte ของ source release เดิมที่สูญหาย การรัน production build ไม่ได้หมายความว่าระบบได้รับการรับรองให้เก็บข้อมูลผู้ป่วยจริง รุ่นนี้ยังมีข้อกำหนด `synthetic-staging` และการผูกกับ origin ที่ตรวจสอบไว้

## 1. ทดลองหน้าเดโมบนเครื่อง

ต้องมี Git และ **Node.js 24.15.0 ขึ้นไป** พร้อม npm ใช้ `package-lock.json` ที่ให้มา ไม่ต้องมีฐานข้อมูลหรือบัญชี LINE สำหรับเดโม

```bash
git clone https://github.com/akwaa2545-gif/Dental-Booking.git
cd Dental-Booking
npm ci
APP_BUILD=demo npm run dev
```

เปิด URL localhost ที่ Vite แสดง เดโมใช้ข้อมูลสมมติและไม่ได้ส่ง LINE จริง อย่ากรอกข้อมูลผู้ป่วยจริง

Windows PowerShell:

```powershell
npm ci
$env:APP_BUILD="demo"
npm run dev
```

สร้างไฟล์เดโม:

```bash
APP_BUILD=demo npm run build
npm run preview
```

`npm run dev` หรือ `npm run build` โดยไม่กำหนด `APP_BUILD=demo` จะเลือก frontend สำหรับ runtime จริง ซึ่งต้องมีการตั้งค่า LINE และ backend

## 2. สิ่งที่ต้องมีสำหรับ runtime ที่เชื่อม LINE/ฐานข้อมูล

- PostgreSQL **17** ในสภาพแวดล้อมที่ตรงกับ role/ACL ที่ migration ตรวจสอบไว้ โครงการเดิมใช้ Supabase; อย่าคาดว่า PostgreSQL เปล่าหรือเวอร์ชันอื่นจะใช้ migration ได้ทันที
- Cloudflare Workers และ Hyperdrive binding ชื่อ `DENTAL_DB` ใช้บัญชีฐานข้อมูลที่มีสิทธิ์ต่ำตามโมเดลใน migration และปิด query caching
- LINE Developers Provider, LINE Login channel พร้อม LIFF app และ LINE Official Account/Messaging API channel ที่สัมพันธ์กันอย่างถูกต้อง
- HTTPS origin, LIFF endpoint และ callback/webhook URL ที่ตรงกัน
- ผู้ดูแลฐานข้อมูลสำหรับตรวจ migration และสร้างสิทธิ์แอดมินเริ่มต้นผ่านขั้นตอนที่ตรวจสอบแล้ว ระบบไม่สร้างแอดมินจากการ login ของผู้ใช้ทั่วไป
- การจัดการ secrets ที่ฝั่ง server รวมถึงค่า HMAC สำหรับ request limits; ห้ามใส่ token, secret หรือ connection string ใน frontend, `VITE_*`, Git หรือไฟล์ public

บัญชี Cloudflare, Supabase และ LINE ที่มีอยู่แล้วสามารถนำมาใช้ได้เมื่อสิทธิ์และการตั้งค่าตรงกัน ค่าใช้จ่ายขึ้นกับแผนและการใช้งานของแต่ละผู้ให้บริการ

### ตัวแปรและ secrets

ดู `.env.example` และ `wrangler.runtime.jsonc` เป็นตัวอย่างแยกหน้าที่ ตัวอย่างไม่ได้เชื่อมกับฐานข้อมูลของคุณ และไม่ได้ให้สิทธิ์ deploy

ค่าที่เป็น public configuration ได้แก่ `APP_ORIGIN`, `LINE_CHANNEL_ID`, `LINE_PROVIDER_ID`, `LINE_LIFF_ID` และ `APP_STAGE`

ค่า server-only ได้แก่:

- `RATE_LIMIT_KEY_SECRET`: ค่าสุ่มอย่างน้อย 32 bytes สำหรับ request limits
- `LINE_CHANNEL_SECRET`: ใช้เมื่อเปิดเส้นทาง browser OAuth; LIFF token verification ไม่ต้องใช้ secret นี้
- `LINE_MESSAGING_ACCESS_TOKEN`: ใช้ส่งข้อความ/ตรวจ Messaging API ที่เปิดไว้
- `LINE_MESSAGING_CHANNEL_SECRET`: ตรวจลายเซ็น webhook ของ Messaging channel
- ข้อมูลเชื่อมต่อ PostgreSQL: เก็บผ่าน Hyperdrive/secret storage ไม่ใช่ browser environment

การเปิด webhook/การส่งข้อความ/การแจ้งเตือนต้องตั้งค่าธงและ destination ให้ครบ รวมถึงตรวจโควตา/สิทธิ์/สถานะรับข้อความ ไม่ควรเปิดทุกธงพร้อมกัน ระบบหลายส่วนตั้งใจ fail closed เมื่อ configuration ไม่ครบ

### ข้อจำกัดก่อนนำไปรันในบัญชีใหม่

notification payload และฐานข้อมูลบางส่วนผูกกับ staging origin และ version contract ที่ตรวจสอบไว้ การเปลี่ยน `APP_ORIGIN` เพียงจุดเดียวไม่เพียงพอสำหรับย้ายระบบทั้งหมด ห้าม replace origin, catalog hash, ACL หรือ payload version แบบเหมารวมเพื่อให้ migration ผ่าน ต้องปรับอย่างสอดคล้องและทดสอบ retry, idempotency,สิทธิ์เข้าถึง และลิงก์ในการ์ดก่อน

นี่จึงเป็น source สำหรับพัฒนา/ทดสอบและเตรียม self-hosting ไม่ใช่ one-click production installer

## 3. ฐานข้อมูลและ migration

ไฟล์อยู่ใน `db/migrations/` เรียงตามเลขจริงในชื่อไฟล์ **ไม่มีไฟล์007**:

- 001 + 002 ต้องประกอบเป็น atomic bundle ตาม `npm run prepare:db`
- 003, 004, 005
- สร้าง runtime role และ membership ตามโมเดลสิทธิ์ที่ตรวจสอบไว้ ก่อน006
- 006, 008, 009, 010, 011, 012, 013, 014, 015, 016 ตามลำดับ

migration มี baseline fingerprint, role/ACL/RLS และ transaction guards เพื่อปฏิเสธ schema ที่ไม่ตรง รุ่น015และ016ต้องคงลำดับ version bridge และ commit boundary ตาม SQL

**อย่ารัน migration ทั้งหมดซ้ำบนฐานข้อมูลที่มีอยู่แล้ว** สำรองข้อมูล ตรวจ migration history และสถานะจริงก่อน แล้วรันเฉพาะส่วนที่ยังไม่เคย apply หลัง review ใน disposable clone การที่ migration ปฏิเสธไม่ใช่เหตุผลให้ลบ guard หรือให้ runtime เป็น superuser

`db/proposals/` เป็น SQL สำหรับตรวจสอบ/ทดสอบเฉพาะกรณี ไม่ใช่ขั้นตอนติดตั้งอัตโนมัติ และบางไฟล์ใช้ synthetic fixture ชั่วคราว

## 4. ตรวจสอบ source และ build

```bash
npm run typecheck
npm run lint
npm run test:unit
APP_BUILD=demo npm run build
npm run build:runtime
```

`build:runtime` สร้าง `artifacts/runtime/entry.js`, build report และ metadata โดยใช้ Wrangler **dry run เท่านั้น** ไม่มีการ deploy และจะไม่โหลด secrets จากไฟล์ `.env` เข้ามาใน bundle

การ build ผ่านยังไม่ยืนยันว่าฐานข้อมูล/LINE/bindings ของคุณพร้อมใช้งาน ต้อง review missing bindings และ runtime configuration แยกต่างหาก อย่า deploy ด้วย configuration ตัวอย่างทับ Worker ที่ใช้งานอยู่ เพราะอาจเปลี่ยน feature flags หรือ bindings เดิม

### ทดสอบฐานข้อมูลในเครื่อง

ต้องมี PostgreSQL17 server/client binaries (`postgres`, `initdb`, `pg_ctl`, `pg_dump`, `pg_restore`) ที่เชื่อถือได้ สคริปต์สร้าง cluster ใหม่บน loopback พร้อมข้อมูลสมมติ และปิด cluster หลังทดสอบ

```bash
PG17_BIN=/path/to/postgresql17/bin \
PG17_CLIENT_BIN=/path/to/postgresql17/bin \
bash scripts/test-local-db.sh
```

อย่าชี้ test suite ไปยังฐานข้อมูลที่ใช้งานจริง หรือแก้ target guard เพื่อให้ทดสอบผ่าน

### ทดสอบหน้าจอ

ติดตั้ง browser สำหรับ Playwright ตามสภาพแวดล้อมของคุณ แล้วรัน:

```bash
npm run test:e2e
```

config จะเริ่ม demo server ในเครื่องเอง ถ้ากำหนด `DEMO_BASE_URL` จะใช้ URL นั้นแทน: ใช้เฉพาะระบบทดสอบที่คุณมีสิทธิ์ และอย่ากำหนดเป็นระบบผู้ป่วยจริง

## โครงสร้าง

- `src/web/`: frontend/LIFF/admin UI
- `src/demo/`: adapter และข้อมูลสมมติของเดโม
- `src/worker/`: API, authentication, authorization และ notifications
- `src/shared/`: contract/validation ที่ใช้ร่วมกัน
- `db/migrations/`: schema และสิทธิ์ฐานข้อมูลแบบ versioned
- `tests/`: unit, UI, Worker, PostgreSQL และ browser regression tests
- `scripts/`: build และ local-only verification

repository นี้ไม่รวม credentials, ฐานข้อมูลผู้ป่วย, ประวัติ Git ภายในเดิม หรือหลักฐานการปฏิบัติงานส่วนตัว
