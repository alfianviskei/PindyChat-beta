# PindyChat — Panduan Fitur Lengkap

> Dokumentasi fitur berdasarkan investigasi source code LibreChat.
> Domain: `chat.pindyyogurt.store`

---

## Daftar Isi

1. [Thinking Mode (Extended Reasoning)](#1-thinking-mode-extended-reasoning)
2. [Web Search (Browsing)](#2-web-search-browsing)
3. [PDF Parsing](#3-pdf-parsing)
4. [Memory (Ingatan Antar-Conversation)](#4-memory-ingatan-antar-conversation)
5. [File Upload](#5-file-upload)
6. [useResponsesApi — Penjelasan Teknis](#6-useresponsesapi--penjelasan-teknis)
7. [Daftar Build Tools Qwen](#7-daftar-build-tools-qwen)
8. [Konfigurasi Saat Ini](#8-konfigurasi-saat-ini)
9. [Maintenance & Troubleshooting](#9-maintenance--troubleshooting)

---

## 1. Thinking Mode (Extended Reasoning)

### Apa itu?
Thinking mode adalah fitur di mana model AI melakukan **internal reasoning/chain-of-thought** sebelum menjawab. Model "berpikir" terlebih dahulu — menganalisis, merencanakan, mempertimbangkan alternatif — baru kemudian menghasilkan jawaban final.

### Bagaimana di PindyChat?
- **Status**: ✅ AKTIF (`enable_thinking: true`)
- **Parameter**: `addParams.enable_thinking: true` di `librechat.yaml`
- **Mekanisme**: Parameter ini dikirim langsung ke Qwen API sebagai top-level field di request body
- **Efek**: Jawaban lebih kompleks dan mendalam, tapi lebih lambat

### Toggle di UI
Ada toggle **"Show Thinking"** di UI LibreChat:
- **Lokasi**: Settings → Chat → Show Thinking
- **Fungsi**: Mengontrol apakah konten thinking/reasoning **ditampilkan** di UI
- **Penting**: Toggle ini HANYA mengontrol tampilan, BUKAN mengaktifkan/mematikan thinking di sisi model
  - `enable_thinking: true` di config → model SELALU berpikir (di sisi API)
  - "Show Thinking" di UI → menentukan apakah kamu bisa LIHAT proses berpikirnya

### File terkait (source code):
- `packages/api/src/endpoints/openai/llm.ts` — parameter processing
- `client/src/components/Nav/SettingsTabs/Chat/ShowThinking.tsx` — UI toggle
- `client/src/store/showThinking.ts` — state atom (Jotai, default: false)
- `client/src/components/Chat/Messages/Content/Part.tsx` — rendering thinking content

---

## 2. Web Search (Browsing)

### Apa itu?
Web search memungkinkan model mencari informasi terkini dari internet saat menjawab pertanyaan yang membutuhkan data aktual.

### Bagaimana di PindyChat?
- **Status**: ✅ AKTIF — **default menyala, tapi bisa dimatikan per chat**
- **Mekanisme**: Qwen's **built-in `web_search` tool** via Responses API
- **Provider**: Qwen native (gratis, tidak butuh API key tambahan)

### Konfigurasi: `paramDefinitions`, bukan `addParams`

Sejak v0.8.9-rc1 browsing dinyalakan lewat **default parameter**, bukan literal:

```yaml
customParams:
  paramDefinitions:
    - key: web_search
      type: boolean
      default: true      # menyala tanpa perlu disentuh
      component: switch
```

`web_search` **sengaja tidak** ditaruh di `addParams`. Loop `addParams` berjalan paling akhir
dan menimpa tanpa syarat (`llm.ts:784-786`), jadi literal di sana membuat browsing menyala
selamanya dan switch di UI jadi pajangan. `paramDefinitions` dibaca sebagai `defaultParams`
(`llm.ts:695-701`) yang hanya dipakai **selama request belum menentukan nilainya** — jadi
posisi OFF dari pengguna tetap menang.

### Alur Teknis (dari source code):
```
1. User kirim pesan
2. defaultParams.web_search = true dipakai bila switch belum disentuh
3. LibreChat set useResponsesApi = true (llm.ts:846-849)
4. LibreChat push { type: 'web_search' } ke tools array
5. Request dikirim ke /compatible-mode/v1/responses Qwen
6. Qwen mencari di server mereka, mengirim event web_search_call
7. Bridge kita mengubah event itu menjadi kartu pencarian di UI
```

### Bukti live: tanpa tool, Qwen tidak mencari sama sekali

Probe SSE langsung ke gateway (bukan dokumentasi), pertanyaan yang sama:

| Request | Item `web_search_call` | Event lifecycle | Sumber |
|---|---|---|---|
| Dengan `tools: [{type:'web_search'}]` | **6** (3 pencarian) | **9** | 30 + 30 + 19 URL |
| Tanpa `tools` | **0** | **0** | — |
| `enable_search: true`, tanpa `tools` | **0** | **0** | — |

Baris ketiga menjawab pertanyaan yang sering muncul: **`enable_search: true` saja
tidak membuat Qwen mencari** di gateway ini. Yang wajib adalah deklarasi tool
`{type:'web_search'}` — jadi tidak perlu menaruh `enable_search` di config.

Urutan yang benar-benar diterima untuk tiap pencarian:

```
response.output_item.added        status=in_progress   (query belum ada)
response.web_search_call.in_progress
response.web_search_call.searching
response.web_search_call.completed
response.output_item.done         status=completed, action.query + action.sources[]
```

Satu jawaban bisa berisi **beberapa** pencarian, masing-masing dengan id, query, dan daftar
sumbernya sendiri — bridge membuat satu kartu per pencarian, bukan satu kartu gabungan.

### Indikator Browsing di UI — SUDAH DIPERBAIKI ✅

Sebelumnya browsing tidak terlihat. Penyebabnya **bukan** konfigurasi Qwen, melainkan celah di
`@langchain/openai`: converter Responses API-nya menaruh `web_search_call` di
`additional_kwargs.tool_outputs` / `generationInfo.tool_outputs` dan **tidak pernah** mengubahnya
menjadi `tool_call_chunk`. SDK `@librechat/agents` hanya membaca `tool_call_chunks`, jadi tidak ada
step `tool_calls` yang dibuat dan kartu `WebSearch` tidak pernah muncul. Celah ini juga mengenai
OpenAI asli, bukan hanya Qwen.

**Solusi yang dipasang** — bridge di sisi server:

| Berkas | Peran |
|---|---|
| `packages/api/src/stream/providerWebSearch.ts` | Pembaca sinyal murni + state machine yang mensintesis `on_run_step` / `on_run_step_completed` / `on_run_step_closed` |
| `packages/api/src/stream/providerWebSearch.spec.ts` | 24 test — lifecycle, index, konkurensi, failure, isolasi error, routing dispatch, normalisasi & publikasi sumber |
| `api/server/controllers/agents/callbacks.js` | Registrasi observer `on_chat_model_stream` + koreksi index di `ON_RUN_STEP` |
| `api/server/services/Endpoints/agents/initialize.js` | Meneruskan lever konfigurasi |
| `packages/data-provider/src/config.ts` | Lever baru `webSearch.providerIndicator` (default `true`) |

Detail penting:

- **Index sintetis negatif.** Aggregator memakai `allocateContentIndex(min) = Math.max(nextContentIndex, min)`,
  sedangkan graph memberi step asli `index = contentData.length` (selalu ≥ 0). Index negatif tidak
  pernah bertabrakan dan selalu jatuh di slot padat berikutnya.
- **Index dikirim ulang dari `stepMap`.** Setelah injeksi, index graph tertinggal dari slot tersimpan,
  jadi `ON_RUN_STEP` mengirim index otoritatif dari `stepMap` — preseden yang sama sudah dipakai
  `ON_RUN_STEP_CLOSED`. Tanpa injeksi, fungsi ini identitas (objek yang sama persis dikembalikan).
- **Observer, bukan dispatcher.** Handler ini sengaja tidak membawa simbol `SDK_STREAM_DISPATCH`,
  sehingga SDK tetap membangun dan menjalankan `ChatModelStreamHandler` internalnya.
- **Tidak mengubah request.** Murni presentasi — tidak ada efek token, biaya, atau isi permintaan.
- **Persisten.** Karena menjadi content part `tool_call` sungguhan, kartu tetap ada setelah reload
  dan setelah reconnect resumable-stream. Ini terjadi karena `on_run_step_completed` dan
  `on_run_step_closed` sintetis **dikembalikan ke handler terdaftar** (`dispatch`), bukan langsung
  ke client: handler `completed` melipat `result.tool_call` (isi `output` yang dirender kartu sebagai
  sumber) ke part tersimpan dan menandai `stepId`, handler `closed` menandai `runStepStatus` dan
  `runStepDurationMs`. Kalau dikirim mentah, part tersimpan tanpa keduanya dan percakapan yang
  dibuka ulang menampilkan kartu pencarian yang macet di tengah.

**Mematikan** (opsional) di `librechat.yaml`:

```yaml
webSearch:
  providerIndicator: false
```

Tanpa konfigurasi apa pun, indikator **aktif secara default**.

### Daftar sumber di kartu — diperbaiki

Kartu `WebSearch` membangun daftar sumbernya dari **attachment `web_search`**, bukan dari
string `output` tool. Karena itu bridge kini menormalkan `action.sources` Qwen
(`{type:'url', url}`) menjadi entri `organic` (`{link, title?, snippet?, position}`) dan
menerbitkannya lewat jalur attachment yang sama dengan plugin search:

- `writeAttachment(...)` → pembaca live, jadi favicon/domain muncul saat kartu masih di layar
- `artifactPromises.push(...)` → tersimpan bersama pesan, jadi daftar sumber **tetap ada setelah reload**

Entri tanpa URL `http(s)` dibuang, bukan dirender sebagai baris kosong. Publikasi dilakukan
sekali per id pencarian walau item yang sama datang berulang.

**Yang terlihat di UI**: "Searching the web" → "Searching the web again" untuk pencarian
berikutnya → "{{count}} sources" dengan tumpukan favicon dan hovercard per situs. Nama situs
muncul saat item selesai: Qwen mengirim `action.sources` hanya pada `output_item.done`,
bukan selama fase `searching`, jadi tidak ada daftar situs yang benar-benar realtime di
tengah pencarian — itu batas dari provider, bukan dari UI.

### Apakah v0.8.9-rc1 sudah menangani ini sendiri? Tidak.

Dicek di seluruh tree upstream: string `web_search_call` **hanya** ada di berkas PindyChat
kita. Upstream masih memakai `@langchain/openai` yang menyimpan item itu di `tool_outputs`
tanpa pernah menjadi `tool_call_chunk`. Jadi bridge ini tetap satu-satunya yang membuat
browsing terlihat — untuk Qwen maupun OpenAI asli.

Yang upstream lakukan: `ToolsDropdown.tsx` dihapus dan diganti command palette
(`usePaletteEntries.tsx`). Aturan gear-nya identik — `searchConfigurable` menolak memunculkan
tombol Configure bila semua `authTypes` bernilai `SYSTEM_DEFINED` (:313-316), persis sinyal
yang dihasilkan lever `webSearch.providerNative` kita. Jadi gear tetap hilang tanpa API key.

### Perbedaan dengan LibreChat Web Search Plugin
| Aspek | Qwen Native (aktif sekarang) | LibreChat Plugin |
|-------|------------------------------|------------------|
| API | Qwen Responses API | Serper/Tavily + Firecrawl |
| Butuh API key? | ❌ Tidak | ✅ Ya (berbayar) |
| Full page scraping | ❌ Tidak | ✅ Ya (Firecrawl) |
| Reranking | ❌ Tidak | ✅ Ya (Jina/Cohere) |
| Setup | Sudah aktif | Butuh 3 API key |

### File terkait (source code):
- `packages/api/src/endpoints/openai/llm.ts:746-750` — web_search interception
- `packages/api/src/endpoints/openai/llm.ts:846-849` — Responses API routing
- `packages/api/src/tools/toolkits/web.ts` — web search toolkit
- `client/src/components/Chat/Messages/Content/WebSearch.tsx` — kartu "Searching the web" yang dirender
- `client/src/components/Chat/Input/WebSearch.tsx` — toggle plugin search (sistem terpisah)

---

## 3. PDF Parsing

### Apa itu?
PDF parsing adalah kemampuan model untuk **membaca dan memahami konten file PDF** yang di-upload user.

### Bagaimana di PindyChat?
- **Status**: ✅ AKTIF via file upload
- **Konfigurasi**: `supportedMimeTypes` termasuk `"application/pdf"` di `fileConfig`
- **Cara kerja**: File PDF di-upload sebagai attachment → dikirim ke model Qwen sebagai bagian dari conversation context

### Perbedaan PDF Parsing di Qwen vs LibreChat
Qwen memiliki **build tool** bernama `pdf_parsing` yang beroperasi di **Completions API** (bukan Responses API). Ini adalah fitur server-side Qwen yang memproses PDF secara internal.

Di LibreChat, PDF yang di-upload dikirim sebagai file attachment ke model. Model Qwen kemudian memproses konten PDF tersebut. Ini berbeda dengan tool `pdf_parsing` yang merupakan built-in tool Qwen.

### Limitasi:
- Max 20 file per request
- Max 25MB per file
- Max 200MB total per request
- Format: PDF, gambar (JPEG, PNG, GIF, WebP, dll)

### File terkait (source code):
- `packages/data-provider/src/file-config.ts` — file configuration schema
- `librechat.yaml` — `fileConfig.endpoints.Qwen-Cloud`

---

## 4. Memory (Ingatan Antar-Conversation)

### Apa itu?
Memory adalah fitur yang memungkinkan AI **mengingat informasi tentang user** across conversations. Misalnya: nama, preferensi, pekerjaan, minat, dll.

### Bagaimana di LibreChat?
Memory di LibreChat adalah fitur **Agents-only** yang menggunakan:
- **set_memory** tool — menyimpan informasi user
- **delete_memory** tool — menghapus informasi user
- **Memory agent** — agent khusus yang secara otomatis mengekstrak informasi dari percakapan

### Komponen Memory:
1. **Memory Badge** — tombol toggle di chat input (ikon otak 🧠)
2. **Memory Artifacts** — menampilkan memori yang disimpan di UI
3. **Memory Info** — panel informasi tentang memori
4. **Personalization** — tab di Settings untuk mengelola preferensi

### Konfigurasi (di `librechat.yaml`):
```yaml
memory:
  disabled: false
  validKeys: ["preferences", "work_info", "personal_info", "skills", "interests", "context"]
  tokenLimit: 10000
  maxInputTokens: 12000
  personalize: true
  agent:
    enabled: true
    # Option 1: Use existing agent by ID
    id: "your-memory-agent-id"
    # Option 2: Define agent inline
    # provider: "openai"
    # model: "gpt-4o-mini"
```

### Status di PindyChat:
- **Belum dikonfigurasi** — Memory adalah fitur Agents, dan PindyChat saat ini hanya menggunakan custom endpoint (Qwen-Cloud)
- Untuk mengaktifkan memory, perlu setup Agents endpoint dengan memory agent
- User bisa opt-out via `user.personalization.memories = false`

### File terkait (source code):
- `client/src/components/Chat/Input/Memory.tsx` — Memory badge UI
- `client/src/components/Chat/Messages/Content/MemoryArtifacts.tsx` — Memory display
- `client/src/components/Chat/Messages/Content/MemoryInfo.tsx` — Memory info panel
- `client/src/components/Chat/Messages/Content/Parts/MemoryCall.tsx` — Memory tool call rendering
- `librechat.example.yaml:1324-1349` — Memory configuration

---

## 5. File Upload

### Status di PindyChat:
- ✅ **Aktif** untuk Qwen-Cloud endpoint
- **Limit**: 20 file per request, 25MB per file, 200MB total
- **Format**: seluruh keluarga yang bisa dibaca LibreChat — teks/kode, Office,
  OpenDocument, epub, gambar, audio (lihat tabel di bawah)

### Tidak perlu mendaftar tipe file satu per satu

Pertanyaan yang wajar: apakah setiap ekstensi harus ditulis di config? **Tidak.**
Justru sebaliknya — menulis daftar sendiri adalah penyebab file ditolak.

`supportedMimeTypes` per endpoint **menggantikan** daftar bawaan, bukan menambahinya,
dan `filterFile` (`api/server/services/Files/process.js:1835-1842`) menolak setiap tipe
yang tidak ada di daftar itu. Konfigurasi lama hanya berisi tiga entri
(`image/.*`, `application/pdf`, audio) — itulah sebabnya Markdown, teks biasa, dan
dokumen Office tidak bisa di-upload.

Solusinya: **hapus** `supportedMimeTypes` dari endpoint. Nilai bawaannya
(`file-config.ts:582-588`) sudah berupa union terkurasi `supportedMimeTypes`
(:361-372) yang mencakup semua keluarga yang ada pembaca/ekstraktornya. Tipe baru
ikut datang bersama update upstream, tanpa perlu mengedit config.

Daftar yang sama juga dipakai browser: `useUploadOptions.ts:58-66` mengambilnya dari
config yang dikirim server, jadi satu perubahan memperbaiki file picker **dan** gerbang
server sekaligus — tidak ada daftar kedua yang perlu disinkronkan.

### Hasil terukur (resolver asli, 38 tipe umum)

| | Sebelum | Sesudah |
|---|---|---|
| Lolos gerbang upload | **8 / 38** | **36 / 38** |
| benar-benar sampai ke model | 8 / 38 | **31 / 38** |

Yang tetap ditolak: executable (`application/x-msdownload`) — memang seharusnya.
Yang lolos tapi tidak dikirim ke model (`none`): arsip zip/tar, parquet, video, `.doc`
lama, dan presentasi/gambar OpenDocument. Tidak ada pembaca yang mengubahnya jadi
teks, jadi file disimpan namun tidak dikirim sebagai byte mentah ke model.

**RTF** adalah satu-satunya format umum yang tidak ada di union bawaan, sehingga tetap
tidak bisa di-upload. Menambahkannya berarti kembali mendaftar tipe satu per satu —
tidak sepadan.

### Bukti live: ekstraksi benar-benar terjadi

Probe ke rute RAG `/text` yang dipakai `parseText`, bukan pembacaan dokumentasi:

| File | Hasil |
|---|---|
| `.md`, `.txt`, `.csv`, `.tsv`, `.json`, `.yaml`, `.sql`, `.py`, `.ts`, `.log`, `.html`, `.eml` | teks asli |
| `.docx` | "This is a sample DOCX file." |
| `.xlsx` | isi sel |
| `.pptx` | teks slide |
| `.epub` | teks bab |
| `.odt` | teks paragraf (setelah perbaikan di bawah) |
| `.xml` berisi text node | "Pindy Yogurt stroberi 15000" |
| `.xml` hanya atribut | kosong — **benar**, tidak ada teks untuk diekstrak |
| file kosong | kosong — **benar** |

### Perbaikan: RAG kadang mengembalikan arsipnya, bukan isinya

Untuk format yang tidak dipartisi RAG (ODT/ODS), ia menjawab **HTTP 200** dengan byte
ZIP arsip itu sendiri sebagai `text`. Karena statusnya sukses, jalur error tidak pernah
jalan dan byte itu tersimpan sebagai teks file lalu diberikan ke model.

`packages/api/src/files/text.ts` kini mendeteksi tanda tangan ZIP dan memakai parser
dokumen bawaan untuk membacanya. Dijalankan ujung-ke-ujung tanpa mock:

```
doc.odt  ok  67 chars  "Pindy Yogurt rasa stroberi dan mangga, harga 15000 per botol 250ml."
```

Hasil kosong **sengaja tidak** dianggap gagal — itu jawaban benar untuk file kosong dan
dokumen tanpa text node, dan ada test lama yang menjaganya.

### Anggaran konteks disesuaikan untuk tier 1M

Bawaan LibreChat berukuran untuk model 128K. Karena tier Qwen kita 1M token:

| Kunci | Bawaan | PindyChat |
|---|---|---|
| `fileTokenLimit` | 100.000 | **200.000** |
| `fileContextCharLimit` | 1.000.000 (~250K token) | **3.000.000** (~750K token) |
| `fileContextSizeLimit` | 128 MB | **200 MB** (sama dengan `totalSizeLimit`) |

Tanpa ini, beberapa dokumen sudah menghabiskan kuota padahal sebagian besar jendela
konteks masih kosong.

### Cara Kerja:
1. User klik ikon paperclip 📎 di chat input
2. Pilih file dari device (banyak file sekaligus, sampai 20)
3. File di-upload ke server LibreChat
4. Teks diekstrak (RAG, atau parser bawaan bila RAG mengembalikan arsipnya)
5. Teks/gambar dikirim sebagai attachment ke model Qwen

### File terkait (source code):
- `packages/data-provider/src/file-config.ts` — union bawaan + resolver routing
- `packages/data-provider/src/resolve-llm-delivery-path.ts` — tujuan tiap tipe
- `packages/api/src/files/text.ts` — ekstraksi + pemulihan arsip
- `api/server/services/Files/process.js` — gerbang `filterFile`
- `client/src/hooks/Files/useUploadOptions.ts` — daftar yang dipakai file picker
- `librechat.yaml` — `fileConfig`

---

## 6. useResponsesApi — Penjelasan Teknis

### Apa itu?
`useResponsesApi` adalah flag internal LibreChat yang mengubah endpoint API dari:
- **Chat Completions**: `/v1/chat/completions` (format lama, standard)
- **Responses API**: `/v1/responses` (format baru OpenAI, support built-in tools)

### Kapan Aktif?
Dari source code (`packages/api/src/endpoints/openai/llm.ts`):

```typescript
// Line 846-849:
} else if (enableWebSearch) {
  llmConfig.useResponsesApi = true;  // ← Switch ke /v1/responses
  tools.push({ type: 'web_search' }); // ← Tambah web_search tool
}
```

`useResponsesApi` otomatis aktif ketika:
1. `web_search: true` di `addParams` → untuk web search built-in tool
2. Model GPT-5 reasoning → untuk reasoning config
3. Model GPT-6 → selalu pakai Responses API

### Bagaimana dengan Qwen?
Qwen's API mendukung **kedua endpoint**:
- `/v1/chat/completions` — standard chat
- `/v1/responses` — untuk built-in tools (web_search, dll)

Konfigurasi saat ini **BENAR**:
- `web_search: true` → `useResponsesApi = true` → request ke `/v1/responses`
- Qwen menerima request dengan `{ type: 'web_search' }` tool dan memprosesnya

### dropParams: ['useResponsesApi']
Jika kamu menambahkan `dropParams: ['useResponsesApi']`, ini akan **memaksa** `useResponsesApi = false` (line 924):
```typescript
if (responsesApiExplicitlyOptedOut) llmConfig.useResponsesApi = false;
```
Ini akan membuat web_search tool ditambahkan ke tools array, TAPI request dikirim ke `/v1/chat/completions` — yang mungkin tidak diproses dengan benar oleh Qwen.

**Kesimpulan**: Konfigurasi saat ini (TANPA `dropParams`) sudah benar.

---

## 7. Daftar Build Tools Qwen

Berikut daftar build tools yang tersedia di Qwen dan API yang dibutuhkan:

| Tool | API | Status di PindyChat | Keterangan |
|------|-----|---------------------|------------|
| `web_search` | Responses API | ✅ Aktif | Pencarian web otomatis |
| `i2i_search` | Responses API | ❌ Belum | Image-to-image search |
| `t2i_search` | Responses API | ❌ Belum | Text-to-image search |
| `web_extractor` | Responses API | ❌ Belum | Ekstraksi konten web |
| `pdf_parsing` | Completions API | ⚠️ Partial | PDF diproses sebagai file attachment |
| `web_fetch` | Anthropic API | ❌ Tidak kompatibel | Format berbeda (Anthropic) |
| `code_interpreter` | Responses API | ❌ Belum | Eksekusi kode |

### Cara Menambah Tool Lain
Untuk menambah tool seperti `i2i_search` atau `t2i_search`, perlu modifikasi source code LibreChat karena tool-tool ini bukan bagian dari standard OpenAI tools. Saat ini hanya `web_search` yang didukung secara native.

---

## 8. Konfigurasi Saat Ini

### `librechat.yaml`:
```yaml
version: 1.3.18
cache: true
fileConfig:
  fileTokenLimit: 200000
  fileContextCharLimit: 3000000
  fileContextSizeLimit: 200
  endpoints:
    Qwen-Cloud:
      fileLimit: 20
      fileSizeLimit: 25
      totalSizeLimit: 200
      # supportedMimeTypes sengaja TIDAK ada — daftar bawaan sudah lengkap.
      # Menulis daftar sendiri justru MENGGANTINYA dan menolak sisanya (§5).
      defaultLLMDeliveryPath:
        overrides:
          "audio/*": text        # transkripsi, bukan input_audio ke model teks
          "application/vnd.openxmlformats-officedocument.presentationml.presentation": text
          "application/epub+zip": text
endpoints:
  custom:
    - name: "Qwen-Cloud"
      apiKey: "${DASHSCOPE_API_KEY}"
      baseURL: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1"
      models:
        default:
          - "qwen3.7-plus"
          - "qwen3.8-max"
          - "qwen4-max-preview"
      fetch: false
      titleConvo: true
      titleModel: "qwen3.7-plus"
      modelDisplayLabel: "Qwen"
      iconURL: "/assets/qwen.svg"
      addParams:
        enable_thinking: true    # ← Extended reasoning aktif
      # web_search TIDAK di sini — lihat §2. Literal di addParams menimpa
      # switch per-chat; defaultnya diatur lewat customParams.paramDefinitions.
      customParams:
        paramDefinitions:
          - key: web_search
            type: boolean
            default: true
            component: switch
            optionType: model
```

### `.env` (relevan):
```env
APP_TITLE=PindyChat
ENDPOINTS=custom
HELP_AND_FAQ_URL=https://chat.pindyyogurt.store
DASHSCOPE_API_KEY=<your-key>
```

---

## 9. Maintenance & Troubleshooting

### Deploy ulang (build dari source):
Sejak branding dan indikator web search hidup di source code — bukan lagi hasil patch
runtime di dalam container — image **harus** dibangun dari checkout ini.
`deploy-compose.yml` sudah mengarah ke `Dockerfile.multi`, dan `npm run start:deployed`
sudah membawa `--build`.

```bash
# Build pertama kali: lama (semua stage dingin). Hentikan stack dulu agar
# build tidak berebut RAM/CPU dengan container yang sedang melayani traffic.
docker compose -f deploy-compose.yml down
NODE_MAX_OLD_SPACE_SIZE=2560 npm run start:deployed

# Build berikutnya: layer npm/dependency ter-cache, hanya stage yang berubah
# yang dikompilasi ulang.
npm run start:deployed
```

`NODE_MAX_OLD_SPACE_SIZE` menurunkan plafon heap build client. Default upstream 6144
mengasumsikan mesin build besar; di VPS kecil angka itu membiarkan Node tumbuh
melampaui RAM fisik dan di-OOM-kill alih-alih melakukan garbage collection.

### Setelah update dari upstream:
```bash
npm run rebase:deployed   # git pull + rebuild
```

### Ganti logo:
Timpa `client/public/assets/logo.svg`, lalu regenerasi ikon PNG-nya:
```bash
docker run --rm -v "$PWD:/app" -w /app/client node:22-alpine \
  sh -c 'apk add --no-cache rsvg-convert >/dev/null && node scripts/generate-icons.mjs'
```
Nama produk dan URL-nya ada di satu tempat: `client/src/constants/brand.ts`.

### Restart Containers:
```bash
docker compose -f deploy-compose.yml down
docker compose -f deploy-compose.yml up -d
```

### View Logs:
```bash
docker compose -f deploy-compose.yml logs -f api
```

### Verify Config:
```bash
curl -sk https://localhost:3080/api/config | python3 -m json.tool
```

### Clear Browser Cache:
Tekan `Ctrl+F5` (Windows/Linux) atau `Cmd+Shift+R` (Mac) untuk hard refresh.

### Common Issues:

**Thinking tidak muncul di UI?**
- Cek Settings → Chat → Show Thinking → aktifkan
- Thinking tetap berjalan di background meskipun toggle off

**Web search tidak terlihat indikatornya?**
- Pastikan image yang berjalan hasil build dari source, bukan image registry upstream
- Pastikan `webSearch.providerIndicator` tidak di-set `false` di `librechat.yaml`
- Indikator hanya muncul kalau provider benar-benar melaporkan item `web_search_call`;
  kalau Qwen menjawab tanpa mencari, tidak ada yang ditampilkan
- Coba tanya pertanyaan yang jelas butuh data terkini: "What's the weather today?"

**PDF tidak bisa di-upload?**
- Cek ukuran file (max 25MB per file)
- Cek format (harus application/pdf)
- Cek total size (max 200MB per request)

**Memory tidak muncul?**
- Memory adalah fitur Agents-only
- Perlu setup Agents endpoint dengan memory agent
- Custom endpoint (Qwen-Cloud) tidak support memory secara native

---

## 10. Hasil Verifikasi Live Gateway Qwen

Semua klaim di bawah diuji langsung terhadap
`https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` memakai key
`DASHSCOPE_API_KEY` yang aktif, bukan dari dokumentasi. Bagian ini menimpa §8
bila keduanya berbeda.

### Model yang benar-benar tersedia

`GET /models` pada key token-plan mengembalikan daftar yang jauh lebih pendek
dari katalog publik Model Studio:

| Diminta | Status | Bukti |
|---|---|---|
| `qwen3.7-plus`, `qwen3.8-max` | ✅ tersedia | ada di `/models`, menjawab normal |
| `wan2.7-image`, `wan2.7-image-pro` | ✅ tersedia | HTTP 200, mengembalikan PNG 2048×2048 |
| `qwen-audio-3.0-tts-plus` | ✅ tersedia | TTS (suara), bukan ASR |
| `qwen-audio-3.0-realtime-plus` | ✅ tersedia | realtime/WebSocket; menolak base64 |
| `qwen-image-3.0-pro` | ✅ tersedia | HTTP 200 via route **native** `/api/v1/services/aigc/multimodal-generation/generation`; PNG sesuai ukuran yang diminta |
| `qwen-audio-3.0-asr-flash` | ⚠️ belum diverifikasi | butuh key Model Studio; route native-nya `/multimodal-generation/generation`, bukan `/audio/transcriptions` |

Route OpenAI-compatible yang **tidak ada** di gateway ini:
`/compatible-mode/v1/images/generations` → 404,
`/compatible-mode/v1/audio/transcriptions` → 404,
`/compatible-mode/v1/audio/speech` → 404. Yang hidup hanya `/chat/completions`,
`/models`, dan route **native** DashScope di atas.

> Catatan koreksi: kesimpulan sebelumnya bahwa `qwen-image-3.0-pro` "tidak ada"
salah. Model itu memang tidak muncul di `/models` dan tidak bisa dipanggil lewat
`/compatible-mode/v1/chat/completions`, tetapi **bisa** lewat route native
DashScope. `/models` hanya mendaftar model chat, jadi absennya di sana bukan
bukti ketiadaan.

### Generate image — sudah diimplementasikan ✅

Tool bawaan LibreChat (`image_gen_oai`) mem-POST ke
`${IMAGE_GEN_OAI_BASEURL}/images/generations`
(`api/app/clients/tools/structured/OpenAIImageTools.js:364`). Route itu 404 di
gateway ini, jadi tool bawaan tidak bisa dipakai. Sebagai gantinya ada tool
khusus **`qwen_image_gen`** yang berbicara langsung ke route native.

Bentuk balasan Qwen bukan amplop OpenAI:

```json
{ "request_id": "...", "output": { "choices": [ { "message": { "content": [
  { "type": "image", "image": "https://dashscope-result-...oss...png?Expires=..." }
] } } ] } },
  "usage": { "output_width": 1664, "output_height": 928, "output_image_count": 1 } }
```

Dua konsekuensi yang menentukan desain tool:

1. `choices` bersarang di bawah `output`, sehingga LangChain tidak bisa
   mem-parse-nya — model ini tidak bisa didaftarkan sebagai custom endpoint biasa.
2. URL gambar **bertanda tangan dan kedaluwarsa ±24 jam** (dikonfirmasi: setiap
   URL mengandung `Expires=`), jadi byte-nya harus diunduh lalu disimpan ke file
   storage LibreChat, bukan dirender langsung.

Tool mengikuti kontrak simpan yang sudah ada: mengembalikan
`[response, { content, file_ids }]` dengan `content` berupa part
`ContentTypes.IMAGE_URL` ber-`data:` URL, persis pola
`OpenAIImageTools.js:209-225`. Karena itu gambar tersimpan permanen dan tetap
muncul setelah percakapan dimuat ulang.

Ukuran kanvas dipetakan dari `aspect_ratio` yang diminta model. Semua nilai di
bawah diverifikasi menghasilkan PNG dengan dimensi persis sebesar itu:

| `aspect_ratio` | `size` dikirim | Hasil nyata | Latensi |
|---|---|---|---|
| `1:1` | `1328*1328` | 1328×1328 | ~25 dtk |
| `16:9` | `1664*928` | 1664×928 | ~35 dtk |
| `9:16` | `928*1664` | 928×1664 | ~29 dtk |
| `4:3` / `3:4` | `1472*1140` / `1140*1472` | — | — |
| `3:2` / `2:3` | `1584*1056` / `1056*1584` | — | — |

Format `size` DashScope adalah `"<lebar>*<tinggi>"`, **bukan** `"1024x1024"`.
Rasio yang tidak dikenal jatuh ke `1:1`.

**Cara pakai:** `qwen_image_gen` adalah tool **khusus Agents** (sama seperti
`image_gen_oai`). Percakapan di custom endpoint Qwen-Cloud tidak memuatnya, jadi
buat/pilih sebuah Agent, lalu centang **Qwen Image Generation** di daftar Tools.

> **Ini sebabnya prompt gambar dijawab teks biasa.** Mengetik "buatkan gambar
> ..." di percakapan Qwen-Cloud tidak memicu apa pun: custom endpoint tidak
> memuat tool sama sekali. `initializeCustomEndpoint`
> (`packages/api/src/endpoints/custom/initialize.ts`) membangun klien tanpa
> `toolDefinitions`/`toolFunctions`, dan satu-satunya pemanggil `loadTools`
> adalah `PluginsClient` — jalur legacy yang tidak dipakai endpoint ini.
> Model tidak punya alat untuk dipanggil, jadi ia menjawab dengan kata-kata.
> Membuat tool tersedia di custom endpoint berarti memberi endpoint itu seluruh
> mesin tool-calling Agents, yang merupakan perubahan arsitektur tersendiri.

**File terkait (source code):**
- `packages/api/src/tools/toolkits/qwen.ts` — URL resolver, peta ukuran, builder
  request, extractor URL, pembaca error (semuanya murni, tanpa I/O)
- `packages/api/src/tools/toolkits/qwen.spec.ts` — 16 unit test
- `packages/api/src/tools/registry/definitions.ts` — registrasi `qwen_image_gen`
- `api/app/clients/tools/structured/QwenImageGen.js` — pemanggilan HTTP + penyimpanan
- `api/app/clients/tools/manifest.json` — entri plugin & auth fields
- `api/app/clients/tools/util/handleTools.js` — wiring constructor

**Konfigurasi (`.env`):**
```
QWEN_IMAGE_BASE_URL=https://token-plan.maas.qwencloudapi.com
QWEN_IMAGE_MODEL=qwen-image-3.0-pro
# QWEN_IMAGE_API_KEY dikosongkan → jatuh ke DASHSCOPE_API_KEY
```
Hanya **origin** yang diambil dari `QWEN_IMAGE_BASE_URL`; path selalu dibangun
ulang, jadi menempelkan base URL chat (`.../compatible-mode/v1`) pun aman.

### Transkrip audio

Model chat menolak modalitas audio secara eksplisit — `qwen3.8-max` membalas
*"An incorrect modal `audio` was entered, which may not be supported by the
model"* — dan gateway token-plan tidak punya `/audio/transcriptions`. Karena itu
`speech.stt.openai` di `librechat.yaml` diarahkan ke **Model Studio**
(`dashscope-intl.aliyuncs.com`).

`DASHSCOPE_STUDIO_API_KEY` kini diisi dengan kredensial yang sama seperti
`DASHSCOPE_API_KEY`. Yang belum terverifikasi adalah apakah key token-plan itu
diterima oleh host Model Studio — bila tidak, langkah STT akan gagal dengan pesan
autentikasi (bukan hilang diam-diam), dan yang dibutuhkan hanyalah key Model
Studio (`sk-...`) di variabel tersebut.

**Tidak ada fallback.** Transkripsi bersifat all-or-nothing: bila provider
menolak, upload dilaporkan sebagai kesalahan — tidak diam-diam diteruskan ke
model chat lain, dan tidak pula diserahkan mentah ke model chat yang tidak bisa
mendengar audio.

#### Batas durasi 5 menit

Model ASR Qwen berhenti di lima menit, dan rekaman yang lebih panjang dibalas
dengan error transport yang hanya bisa ditampilkan klien sebagai **500** polos —
padahal yang perlu dilakukan pengguna hanyalah memecah filenya.

Sekarang durasi diukur lebih dulu dari header kontainer, sebelum membayar round
trip yang pasti gagal:

| Format | Sumber durasi | Ketepatan |
|---|---|---|
| WAV | chunk `data` ÷ byte rate `fmt ` | eksak |
| M4A / MP4 | `moov/mvhd` (versi 0 dan 1) | eksak |
| FLAC | STREAMINFO total samples | eksak |
| MP3 | jumlah frame Xing/Info/VBRI, atau frame walk | eksak bila ada header VBR |
| OGG | bitrate nominal Vorbis × ukuran file | estimasi |

Tanpa decoder, tanpa subprocess, tanpa dependensi baru. Format yang tidak bisa
diukur mengembalikan `null` dan pemeriksaan **dilewati** — menolak upload yang
tidak sanggup kita ukur akan menjebak format yang parser ini tidak kenal, dan
penolakan dari provider tetap menghasilkan 400 yang jelas.

Bila batas terlampaui, balasannya **400** (bukan 500) dengan pesan yang
menyebut kedua durasi, misalnya:

> This recording is 6:00 long, but transcription is limited to 5:00. Split it
> into shorter parts and upload them separately.

Batasnya dapat diatur per provider:

```yaml
speech:
  stt:
    openai:
      maxDurationSeconds: 300   # default; 0 menonaktifkan pemeriksaan
```

### Toggle Web Search sekarang seperti toggle Memory

Sebelumnya `addParams.web_search: true` membuat **setiap** request pasti
browsing, dan `addParams` diterapkan paling akhir (`llm.ts:744-751`) sehingga
menimpa switch per-percakapan. Sekarang `web_search` dikeluarkan dari
`addParams`.

Yang menggantikannya sudah ada di LibreChat dan tidak butuh API key: switch
**"Web search"** di panel model settings, yang `openAICol2` sediakan untuk
custom endpoint (`parameterSettings.ts:934`, dipetakan di `:1257`). Menyala
berarti `openAIParams.web_search` ikut terkirim dan `llm.ts` mengubahnya jadi
`useResponsesApi` + tool `{ type: 'web_search' }` — tanpa kredensial, persis
toggle Memory di sebelahnya.

Sejak v0.8.9-rc1 switch itu **default menyala** lewat
`customParams.paramDefinitions` (lihat §2), jadi browsing tetap otomatis tanpa
perlu disentuh — tapi posisi OFF sekarang benar-benar dihormati, tidak seperti
saat literalnya masih di `addParams`.

Baris "Web search" bergambar roda gigi di menu Tools adalah fitur yang
**berbeda**: plugin pencarian milik LibreChat sendiri (Serper/Tavily untuk
hasil, Firecrawl untuk scraping, Jina/Cohere untuk reranking). Sebelum
v0.8.9-rc1 roda giginya muncul dari `showWebSearchSettings`
(`ToolsDropdown.tsx:103-107`); berkas itu kini dihapus upstream dan digantikan
command palette `usePaletteEntries.tsx`, dengan aturan yang sama persis
(`searchConfigurable`, :313-316).

> **Koreksi:** menghapus `web_search` dari `endpoints.agents.capabilities`
> **tidak** menghilangkan roda gigi di deployment ini. `ENDPOINTS=custom`
> menonaktifkan endpoint Agents, sehingga klien tidak pernah menerima
> `agentsConfig` dan jatuh ke `defaultAgentCapabilities` — yang memuat
> `web_search`. Barisnya tetap dirender apa pun isi `librechat.yaml`.

Yang benar-benar menyembunyikannya adalah `webSearch.providerNative`:

```yaml
webSearch:
  providerNative: true
```

Server lalu menjawab probe kredensial dengan cara yang sama seperti bila
operator menyetel `SERPER_API_KEY` — `getProviderNativeWebSearchAuth` menandai
providers, scrapers, dan rerankers sebagai `SYSTEM_DEFINED`, tepat sinyal yang
dipakai klien untuk menyembunyikan roda gigi dan mem-pin toggle-nya. Aturan itu
selamat dari perombakan v0.8.9-rc1: palette penggantinya memeriksa
`authTypes.every(([, t]) => t === AuthType.SYSTEM_DEFINED)` persis seperti menu
lama. Tanpa perubahan di sisi klien, switch-nya berperilaku seperti Memory:
dinyalakan, model browsing, tidak ada formulir API key.

`authResult` sengaja dibiarkan kosong — tidak ada rahasia untuk dikembalikan,
dan menggema satu akan berarti berbohong.

Perhatikan bedanya dengan `webSearch.providerIndicator` (default `true`), yang
mengatur **kartu "Ran Web Search"** saat provider mencari sendiri. Dua lever
ini mudah tertukar: `providerNative` soal kredensial dan roda gigi,
`providerIndicator` soal indikator visual.

### Upload gambar: base64 diterima, URL eksternal ditolak

Gateway menolak URL gambar eksternal dengan *"The provided URL does not appear
to be valid"*, tetapi menerima `data:image/png;base64,...` — diverifikasi:
`qwen3.8-max` diberi data URL sebuah PNG merah dan menjawab "Red" (HTTP 200).
Artinya vision pada upload hanya jalan bila gambar dikirim sebagai data URL,
bukan sebagai URL file publik.

## Ringkasan Fitur

| Fitur | Status | Cara Kerja | Toggle di UI? |
|-------|--------|------------|---------------|
| Thinking Mode | ✅ Aktif | `addParams.enable_thinking: true` → Qwen API | Show Thinking (display only) |
| Web Search | ✅ Aktif, default ON | `paramDefinitions.web_search.default: true` → `useResponsesApi` + tool `{type:'web_search'}`; kartu "Searching the web" + daftar sumber via bridge kita | ✅ "Web search" di model settings, tanpa API key, OFF dihormati |
| PDF Parsing | ✅ Aktif | File upload → attachment ke model | Tidak ada |
| File Upload | ✅ Aktif | Paperclip icon → upload ke server | Tidak ada |
| Memory | ❌ Belum | Agents-only feature | Perlu setup Agents |
| Image Gen | ✅ Aktif (Agents) | tool `qwen_image_gen` → route native DashScope → `qwen-image-3.0-pro`; gambar diunduh & disimpan permanen (lihat §10) | Centang "Qwen Image Generation" di Tools sebuah Agent |
| Audio Transcription | ⏳ Menunggu key valid | `speech.stt.openai` → Model Studio; `DASHSCOPE_STUDIO_API_KEY` sudah diisi, perlu key `sk-...` bila token-plan ditolak (lihat §10) | Tidak ada |

---

## 11. Lever konfigurasi baru di v0.8.9-rc1

Merge ini menambah 13 kunci tingkat atas pada `configSchema`. Yang relevan untuk
PindyChat, beserta penilaian jujur apakah perlu disetel:

| Kunci | Isi | Perlukah disetel sekarang? |
|---|---|---|
| `projects` | Chat Projects — instruksi & file referensi bersama per proyek | Opsional; fitur baru, default sudah aman |
| `passkeys` | Login passkey (WebAuthn) | Opsional; perlu HTTPS yang sudah kita punya |
| `emailChange` | Izinkan ganti email + konfirmasi | Opsional |
| `passwordHashing` | Parameter hashing kata sandi | **Jangan** diubah tanpa alasan; mengubahnya berisiko pada login yang ada |
| `timeouts` | Batas waktu RAG, OCR, actions, moderation, imageFetch | Berguna bila RAG lambat. **Bukan** untuk respons chat yang lambat — stream model tidak lewat sini |
| `conversationList` | Perilaku daftar percakapan di sidebar | Opsional |
| `toolCallPreviews` | Pratinjau panggilan tool | Opsional |
| `mcpAppSandbox` | Sandbox MCP Apps (byte/timeout/admission) | Hanya bila memakai MCP Apps |
| `fileListLimit` | Batas item daftar file | Opsional |
| `credentials` | Kebijakan kredensial | Biarkan default |
| `skillDeletion` | Kebijakan hapus skill | Biarkan default |
| `githubCompare` | Status PR di header/sidebar | Tidak relevan; butuh repo GitHub terhubung |
| `telemetry` | Telemetri | Biarkan default |

Selain itu `CONFIG_VERSION` naik ke **1.3.18** — sudah disamakan di
`librechat.yaml`, jadi peringatan "Outdated Config version" tidak muncul.

### Registry identitas provider: host Qwen Cloud kini terdaftar

`packages/api/src/endpoints/custom/providers.ts` memetakan host ke identitas
provider. Bawaan upstream hanya mengenal `dashscope.aliyuncs.com`; host kita
`token-plan.maas.qwencloudapi.com` tidak cocok, sehingga endpoint berstatus tanpa
identitas provider. Kini ditambahkan (bukan menggantikan — kedua host milik Qwen
Cloud):

```ts
['dashscope.aliyuncs.com', ProviderId.qwen],
['dashscope-intl.aliyuncs.com', ProviderId.qwen],
['qwencloudapi.com', ProviderId.qwen],
```

Pencocokannya berbatas subdomain (`hostname === suffix || hostname.endsWith('.' + suffix)`),
jadi satu entri apex menutup semua prefiks tenant — `token-plan.maas.…`,
`maas.…`, dan tenant lain — tanpa perlu mendaftar satu per satu. Host tiruan
seperti `evil-qwencloudapi.com` tetap tidak cocok (ada test-nya).

**Apa yang tidak berubah: tidak ada fitur baru yang terbuka.** `providerId`
hanya sinyal merek, dikonsumsi komponen ikon (`useProviderIcon`, `ConvoIcon`,
`MessageEndpointIcon`, `GroupIcon`, `SpecIcon`, `AgentConfig`). Gerbang kemampuan
memakai sinyal yang sama sekali lain:

| Dicek langsung | Hasil |
|---|---|
| `EModelEndpoint` punya `qwen`? | **tidak** — hanya azureOpenAI, openAI, google, anthropic, assistants, azureAssistants, agents, custom, bedrock |
| `isKnownProviderIdentifier('qwen')` | `false` |
| `isMediaSupportedProvider('qwen')` | `false` |
| `isDocumentSupportedProvider('qwen')` | `false` |
| `isOpenAILikeProvider('qwen')` | `false` |

Routing upload membaca field `provider` (dialek), **bukan** `providerId`
(`routing.ts:124-137`), dan field itu hanya menerima `"anthropic"`
(`config.ts:2305`). Jadi kemampuan tetap datang dari `supportedMimeTypes`,
`paramDefinitions`, `addParams`, dan Agents untuk tool — bukan dari pendaftaran
host. Keuntungan nyatanya kecil: marka Qwen resmi jadi fallback di tempat yang
tidak membawa `iconURL`. Ikon kita sendiri tetap menang, karena `iconURL` berupa
alamat gambar berada di precedence tertinggi (`useProviderIcon.ts:30-32`).

**Tetap tidak disarankan** mengganti `name` menjadi `Qwen`: nama endpoint
tersimpan per percakapan, jadi menggantinya akan menyatimkan chat yang sudah ada.

### Jendela konteks: `qwen3.8-max` dan `qwen4-max-preview` 1M

`maxTokensMap` mencocokkan id model secara substring terpanjang. Tanpa kunci
sendiri, tier hosted jatuh ke jendela generasinya — atau lebih buruk, ke kunci
`qwen` telanjang. Diukur sebelum/sesudah pada endpoint `custom`:

| Model | Sebelum | Sesudah |
|---|---|---|
| `qwen3.7-plus` | 1.000.000 | 1.000.000 |
| `qwen3.8-max` | 262.144 | **1.000.000** |
| `qwen4-max-preview` | 32.000 | **1.000.000** |
| `qwen4.0-max-preview` | 32.000 | **1.000.000** |
| `qwen3.8` (open-weight) | 262.144 | 262.144 |

Angka ini mengatur anggaran konteks yang dikirim ke model, jadi nilai yang
terlalu kecil membuat percakapan panjang dipangkas padahal ruangnya masih ada.

Spelling ganda itu perlu: gateway menjawab alias `qwen4-max-preview` dengan id
kanonik **`qwen4.0-max-preview`** pada field `model` responsnya (diverifikasi
live, HTTP 200), sehingga daftar model hasil fetch atau percakapan tersimpan bisa
membawa salah satunya. Kedua model dikonfirmasi hidup di key token-plan.

---

*Dokumentasi ini berdasarkan investigasi source code LibreChat.*
*Update terakhir: 2026-11-12 — upload dibuka untuk seluruh keluarga yang bisa dibaca (8/38 → 36/38 tipe), anggaran konteks disesuaikan untuk tier 1M, pemulihan ekstraksi ODT/ODS.*
