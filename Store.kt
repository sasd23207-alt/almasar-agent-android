package ly.almasar.pos

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * تخزين محلي دائم داخل مساحة التطبيق (لا يعتمد على المتصفح):
 *  - state.json  : الحالة الحالية، تُكتب بشكل ذري (ملف مؤقت ثم إعادة تسمية)
 *  - state.prev  : النسخة السابقة تلقائياً، تُستعمل إذا تلف الملف الرئيسي
 *  - backups/    : نسخة يومية (آخر 60 يوماً)
 */
class Store(private val dir: File) {
    private val cur = File(dir, "state.json")
    private val prev = File(dir, "state.prev")
    private val tmp = File(dir, "state.tmp")
    private val bk = File(dir, "backups").also { it.mkdirs() }
    private var lastDaily = 0L

    private fun ok(f: File): Boolean {
        if (!f.exists() || f.length() < 2) return false
        return f.bufferedReader().use { r ->
            val t = r.readText().trimEnd(); t.startsWith("{") && t.endsWith("}")
        }
    }

    @Synchronized fun load(): String {
        if (ok(cur)) return cur.readText()
        if (ok(prev)) return prev.readText()          // استرجاع تلقائي من النسخة السابقة
        return bk.listFiles()?.filter { ok(it) }?.maxByOrNull { it.name }?.readText() ?: ""
    }

    @Synchronized fun save(json: String) {
        tmp.writeText(json)
        if (ok(tmp)) {
            if (ok(cur)) { prev.delete(); cur.renameTo(prev) }
            if (!tmp.renameTo(cur)) { cur.writeText(json) }
            val now = System.currentTimeMillis()
            if (now - lastDaily > 600_000) {            // نسخة يومية كل 10 دقائق كحد أقصى
                lastDaily = now
                File(bk, "almasar-" + SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(now)) + ".json").writeText(json)
                bk.listFiles()?.sortedBy { it.name }?.dropLast(60)?.forEach { it.delete() }
            }
        }
    }
}
