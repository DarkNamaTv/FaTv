# TV Scrap

کاتالوگ شبکه‌های تلویزیونی فارسی‌زبان از روی فید رمزنگاری‌شدهٔ اپ My Online TV —
همراه با اسکرپر خودکار، آینهٔ داخلی فید. بدون dependency، فقط Node 22.

## لینک‌ها

| چی | لینک |
| --- | --- |
| ریپو | https://github.com/DarkNamaTv/FaTv |
| کاتالوگ JSON | https://raw.githubusercontent.com/DarkNamaTv/FaTv/main/data/channels.json |
| سید CSV | https://raw.githubusercontent.com/DarkNamaTv/FaTv/main/data/seed-data.csv |
| آینهٔ فید | https://raw.githubusercontent.com/DarkNamaTv/FaTv/main/mirror/posts |
| لوگوها | https://github.com/DarkNamaTv/FaTv/tree/main/data/logos |
## دیتا

- `data/channels.json` — کاتالوگ اصلی (فعلاً ۳۲۹ شبکه / ۲۰ دسته)؛ هر شبکه اسم فارسی و
  انگلیسی، لوگو، استریم اصلی و سرورهای بکاپ دارد.
- `data/seed-data.csv` — همان دیتا در قالب CSV سید (BOM ،CRLF) برای ایمپورت در دیتابیس.
- `data/logos/` — حدود ۴۰۰ لوگوی استخراج‌شده از خودِ اپ (self-host).
- `mirror/` — کپی فید رمزنگاری‌شده داخل همین ریپو؛ روزی دو بار با اکشن تازه می‌شود تا
  هیچ مصرف‌کننده‌ای به هاست ثالث نیاز نداشته باشد.
- `reports/apk-analysis.json` — گزارش تحلیل APK؛ کلید و IV هم اینجاست
  (`decryption.keyHex` / `decryption.ivHex`) و هم باید در سکرت‌های ریپو ست شود.

## اکشن‌ها

| ورک‌فلو | کار |
| --- | --- |
| `scrape-channels` | روزانه: خواندن آینه، رمزگشایی، تست واقعی استریم‌ها، ادغام و انتشار کاتالوگ |
| `mirror-upstream` | روزی دو بار: تازه‌سازی `mirror/` از upstream (فقط در صورت تغییر کامیت می‌کند) |
| `ci` | روی هر پوش: `npm test` + اعتبارسنجی کاتالوگ |

سکرت‌های لازم (`MYTVSAT_AES_KEY_HEX` / `MYTVSAT_AES_IV_HEX`) را از
`reports/apk-analysis.json` بخوان و در صفحهٔ Secrets ریپو ست کن.

## دستورات

```sh
npm test                  # همهٔ تست‌ها (آفلاین)
npm run scrape:dry        # اجرای آزمایشی بدون نوشتن
npm run scrape            # بازسازی کامل کاتالوگ
npm run validate -- data/channels.json
```

## ساختار

```
config/scrape-sources.json   تنها منبع: فید رمزنگاری‌شده + تنظیمات
scripts/scrape-channels.mjs  CLI اصلی (خواندن، پروب، ادغام، محافظ‌ها)
scripts/import-mytvsat.mjs   ایمپورت دستی بعد از آپدیت اپ
scripts/validate-catalog.mjs اعتبارسنجی خروجی
scripts/lib/                 catalog / sources / http / extract / util
tests/                       تست‌های آفلاین
```
