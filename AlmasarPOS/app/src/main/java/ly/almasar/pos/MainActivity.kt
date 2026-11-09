package ly.almasar.pos

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Size
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.ZoomSuggestionOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** المسار POS: النظام كاملاً + ماسح باركود أصلي، بتخزين محلي وبدون إنترنت. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var pv: PreviewView
    private lateinit var store: Store
    private var provider: ProcessCameraProvider? = null
    private var cam: Camera? = null
    private var scanner: BarcodeScanner? = null
    private var camOn = false
    private val exec = Executors.newSingleThreadExecutor()
    private var last = ""
    private var lastT = 0L
    private var fcb: ValueCallback<Array<Uri>>? = null
    private var printView: WebView? = null

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fcb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)); fcb = null
    }

    inner class Bridge {
        @JavascriptInterface fun load(): String = store.load()
        @JavascriptInterface fun save(json: String) = store.save(json)
        @JavascriptInterface fun toggleCamera() = runOnUiThread { setCamera(!camOn) }
        @JavascriptInterface fun print(html: String) = runOnUiThread {
            val w = WebView(this@MainActivity); printView = w
            w.webViewClient = object : WebViewClient() {
                override fun onPageFinished(v: WebView, u: String) {
                    (getSystemService(PRINT_SERVICE) as PrintManager)
                        .print("فاتورة", v.createPrintDocumentAdapter("invoice"), PrintAttributes.Builder().build())
                }
            }
            w.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        }
        @JavascriptInterface fun exportBackup(json: String, name: String) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    val v = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, "application/json")
                    }
                    val u = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
                    contentResolver.openOutputStream(u)!!.use { it.write(json.toByteArray()) }
                } else File(getExternalFilesDir(null), name).writeText(json)
                toast("تم حفظ النسخة في مجلد التنزيلات (Downloads)")
            } catch (e: Exception) { toast("تعذر حفظ النسخة") }
        }
    }

    private fun toast(t: String) = runOnUiThread { Toast.makeText(this, t, Toast.LENGTH_LONG).show() }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        store = Store(filesDir)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        web = WebView(this)
        pv = PreviewView(this).apply { visibility = View.GONE }
        col.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        col.addView(pv, LinearLayout.LayoutParams(-1, (resources.displayMetrics.density * 260).toInt()))
        setContentView(col)

        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; mediaPlaybackRequiresUserGesture = false }
        web.addJavascriptInterface(Bridge(), "AndroidApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest) = loader.shouldInterceptRequest(r.url)
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onJsConfirm(v: WebView, u: String, m: String, r: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(m).setCancelable(false)
                    .setPositiveButton("موافق") { _, _ -> r.confirm() }.setNegativeButton("إلغاء") { _, _ -> r.cancel() }.show()
                return true
            }
            override fun onJsAlert(v: WebView, u: String, m: String, r: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(m).setPositiveButton("حسناً") { _, _ -> r.confirm() }.show(); return true
            }
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fcb?.onReceiveValue(null); fcb = cb
                chooser.launch(Intent(Intent.ACTION_GET_CONTENT).apply { type = "*/*"; addCategory(Intent.CATEGORY_OPENABLE) })
                return true
            }
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    private fun setCamera(on: Boolean) {
        if (on && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1); return
        }
        camOn = on; pv.visibility = if (on) View.VISIBLE else View.GONE
        if (on) start() else { provider?.unbindAll(); cam = null }
    }

    override fun onRequestPermissionsResult(c: Int, p: Array<out String>, r: IntArray) {
        super.onRequestPermissionsResult(c, p, r)
        if (r.isNotEmpty() && r[0] == PackageManager.PERMISSION_GRANTED) setCamera(true)
    }

    private fun start() {
        val f = ProcessCameraProvider.getInstance(this)
        f.addListener({
            val pr = f.get().also { provider = it }
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(pv.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            pr.unbindAll()
            cam = pr.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            val maxZ = cam?.cameraInfo?.zoomState?.value?.maxZoomRatio ?: 1f
            val zoom = ZoomSuggestionOptions.Builder(ZoomSuggestionOptions.ZoomCallback { z ->
                cam?.cameraControl?.setZoomRatio(z); true      // تكبير تلقائي للباركود البعيد
            }).setMaxSupportedZoomRatio(maxZ).build()
            val sc = BarcodeScanning.getClient(BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_ITF, Barcode.FORMAT_QR_CODE)
                .enableAllPotentialBarcodes().setZoomSuggestionOptions(zoom).build())
            scanner = sc
            analysis.setAnalyzer(exec) { p -> analyze(p, sc) }
            pv.setOnTouchListener { _, e ->
                if (e.action == MotionEvent.ACTION_UP)
                    cam?.cameraControl?.startFocusAndMetering(FocusMeteringAction.Builder(pv.meteringPointFactory.createPoint(e.x, e.y)).build())
                true
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun analyze(p: ImageProxy, sc: BarcodeScanner) {
        val img = p.image
        if (img == null) { p.close(); return }
        sc.process(InputImage.fromMediaImage(img, p.imageInfo.rotationDegrees))
            .addOnSuccessListener { l -> l.firstOrNull { it.rawValue != null }?.rawValue?.let { hit(it) } }
            .addOnCompleteListener { p.close() }
    }

    private fun hit(code: String) {
        val n = System.currentTimeMillis()
        if (code == last && n - lastT < 1500) return
        last = code; lastT = n
        (getSystemService(VIBRATOR_SERVICE) as Vibrator).vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE))
        web.evaluateJavascript("window.__scan(" + JSONObject.quote(code) + ")", null)   // يُضاف للفاتورة فوراً
    }

    override fun onDestroy() { provider?.unbindAll(); super.onDestroy() }
}
