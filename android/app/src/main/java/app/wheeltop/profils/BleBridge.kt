package app.wheeltop.profils

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.ArrayAdapter
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Transport BLE pour l'interface web (voir js/android-bluetooth.js).
 *
 * Ne connaît RIEN du protocole EDS : il ouvre la liaison Nordic UART, transmet les octets
 * écrits par le JavaScript et renvoie les notifications. Toute la logique (trames, CRC,
 * sécurité) reste dans js/protocol.js, js/eds-session.js et js/tuning.js.
 *
 * Toutes les opérations Bluetooth s'exécutent sur le thread principal.
 */
@SuppressLint("MissingPermission") // permissions vérifiées par MainActivity.ensureBlePermissions
class BleBridge(private val activity: MainActivity, private val webView: WebView) {

    private val main = Handler(Looper.getMainLooper())
    private val adapter get() = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    private var gatt: BluetoothGatt? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private var lastDevice: BluetoothDevice? = null
    private var connectId: String? = null // requête de connexion en cours
    private var connectTimeout: Runnable? = null
    private var connected = false

    // File d'écriture : une seule opération GATT à la fois
    private val writeQueue = ArrayDeque<Pair<String, ByteArray>>()
    private var writeInFlight: String? = null

    // ---------------------------------------------------------------- API JavaScript
    @JavascriptInterface
    fun requestDevice(id: String) {
        main.post {
            activity.ensureBlePermissions { ok ->
                when {
                    !ok -> fail(id, "Permissions Bluetooth refusées. Autorisez « Appareils à proximité » dans les réglages de l'appli.", "SecurityError")
                    adapter == null -> fail(id, "Ce téléphone n'a pas de Bluetooth.", "NotSupportedError")
                    !adapter.isEnabled -> fail(id, "Le Bluetooth est désactivé. Activez-le puis réessayez.", "NetworkError")
                    else -> chooseDevice(id)
                }
            }
        }
    }

    @JavascriptInterface
    fun reconnect(id: String) {
        main.post {
            val d = lastDevice
            if (d == null) fail(id, "Aucun dérailleur choisi.", "NotFoundError") else connect(d, id)
        }
    }

    @JavascriptInterface
    fun write(id: String, b64: String) {
        val bytes = Base64.decode(b64, Base64.NO_WRAP)
        main.post {
            writeQueue.addLast(id to bytes)
            pumpWrites()
        }
    }

    @JavascriptInterface
    fun disconnect() {
        main.post { closeGatt(notify = true) }
    }

    /** Enregistre un fichier texte dans Téléchargements. Renvoie un message pour l'utilisateur. */
    @JavascriptInterface
    fun saveFile(name: String, text: String): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/json")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("création du fichier impossible")
            resolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            "Enregistré dans Téléchargements : $name"
        } else {
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir
            val f = File(dir, name)
            f.writeText(text, Charsets.UTF_8)
            "Enregistré : ${f.absolutePath}"
        }
    } catch (e: Exception) {
        "Échec de l'enregistrement : ${e.message}"
    }

    fun close() {
        main.post { closeGatt(notify = false) }
    }

    // ---------------------------------------------------------------- Choix du dérailleur
    private fun chooseDevice(id: String) {
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            fail(id, "Scan Bluetooth indisponible.", "NetworkError")
            return
        }
        val found = LinkedHashMap<String, BluetoothDevice>()
        val labels = ArrayAdapter<String>(activity, android.R.layout.simple_list_item_1)
        var finished = false
        lateinit var dialog: AlertDialog

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.scanRecord?.deviceName ?: result.device.name ?: return
                if (!name.startsWith("EDS")) return // comme drEDS : filtre sur le préfixe "EDS"
                val addr = result.device.address
                if (found.containsKey(addr)) return
                found[addr] = result.device
                labels.add("$name  ($addr)")
                labels.notifyDataSetChanged()
            }

            override fun onScanFailed(errorCode: Int) {
                if (!finished) { finished = true; dialog.dismiss(); fail(id, "Échec du scan Bluetooth (code $errorCode).", "NetworkError") }
            }
        }
        val stopScan = { try { scanner.stopScan(callback) } catch (_: Exception) {} }

        dialog = AlertDialog.Builder(activity)
            .setTitle("Choisir le dérailleur (secouez le vélo pour le réveiller)")
            .setAdapter(labels) { _, which ->
                finished = true
                stopScan()
                val device = found.values.elementAt(which)
                lastDevice = device
                connect(device, id)
            }
            .setNegativeButton("Annuler") { _, _ -> }
            .setOnDismissListener {
                stopScan()
                if (!finished) { finished = true; fail(id, "Aucun dérailleur choisi.", "NotFoundError") }
            }
            .create()
        dialog.show()

        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(null, settings, callback)
        main.postDelayed({ stopScan() }, 30_000)
    }

    // ---------------------------------------------------------------- Connexion GATT
    private fun connect(device: BluetoothDevice, id: String) {
        closeGatt(notify = false)
        connectId = id
        connectTimeout = Runnable {
            closeGatt(notify = false)
            failConnect("Connexion impossible (dérailleur endormi ? secouez le vélo pour le réveiller).")
        }.also { main.postDelayed(it, 15_000) }
        gatt = device.connectGatt(activity, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (g != gatt) return@post
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    // Les blocs de lecture font 128 octets : il faut un MTU plus grand que 23
                    if (!g.requestMtu(517)) g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    val wasConnected = connected
                    closeGatt(notify = false)
                    if (connectId != null) failConnect("Connexion Bluetooth perdue (code $status).")
                    else if (wasConnected) emit(JSONObject().put("type", "disconnect"))
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            main.post { if (g == gatt) g.discoverServices() }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            main.post {
                if (g != gatt) return@post
                val service = g.getService(SERVICE_UUID)
                val w = service?.getCharacteristic(WRITE_UUID)
                val n = service?.getCharacteristic(NOTIFY_UUID)
                val cccd = n?.getDescriptor(CCCD_UUID)
                if (w == null || n == null || cccd == null) {
                    closeGatt(notify = false)
                    failConnect("Service Bluetooth du dérailleur introuvable.")
                    return@post
                }
                writeChar = w
                g.setCharacteristicNotification(n, true)
                val value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeDescriptor(cccd, value)
                } else {
                    @Suppress("DEPRECATION")
                    cccd.value = value
                    @Suppress("DEPRECATION")
                    g.writeDescriptor(cccd)
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            main.post {
                if (g != gatt) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    closeGatt(notify = false)
                    failConnect("Activation des notifications impossible (code $status).")
                    return@post
                }
                // drEDS laisse 500 ms au dérailleur avant le premier envoi
                main.postDelayed({
                    if (g != gatt) return@postDelayed
                    connected = true
                    connectTimeout?.let { main.removeCallbacks(it) }
                    val id = connectId ?: return@postDelayed
                    connectId = null
                    val name = try { g.device.name } catch (_: SecurityException) { null } ?: "EDS"
                    emit(JSONObject().put("type", "result").put("id", id).put("ok", true).put("name", name))
                }, 500)
            }
        }

        // Android 13+
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            onData(value)
        }

        // Android 12 et moins
        @Deprecated("Remplacé sur Android 13+")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                @Suppress("DEPRECATION")
                onData(c.value.copyOf())
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            main.post {
                val id = writeInFlight ?: return@post
                writeInFlight = null
                if (status == BluetoothGatt.GATT_SUCCESS) ok(id) else fail(id, "Écriture Bluetooth refusée (code $status).", "NetworkError")
                pumpWrites()
            }
        }
    }

    private fun onData(bytes: ByteArray) {
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        main.post { emit(JSONObject().put("type", "data").put("b64", b64)) }
    }

    private fun pumpWrites() {
        if (writeInFlight != null) return
        val (id, bytes) = writeQueue.removeFirstOrNull() ?: return
        val g = gatt
        val c = writeChar
        if (!connected || g == null || c == null) {
            fail(id, "Dérailleur déconnecté.", "NetworkError")
            pumpWrites()
            return
        }
        val type = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE // comme drEDS (writeValueWithoutResponse)
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(c, bytes, type) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            c.writeType = type
            @Suppress("DEPRECATION")
            c.value = bytes
            @Suppress("DEPRECATION")
            g.writeCharacteristic(c)
        }
        if (started) {
            writeInFlight = id
        } else {
            fail(id, "Écriture Bluetooth impossible (pile occupée).", "NetworkError")
            pumpWrites()
        }
    }

    private fun closeGatt(notify: Boolean) {
        val wasConnected = connected
        connected = false
        writeChar = null
        gatt?.let { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        gatt = null
        writeInFlight?.let { fail(it, "Dérailleur déconnecté.", "NetworkError") }
        writeInFlight = null
        while (writeQueue.isNotEmpty()) fail(writeQueue.removeFirst().first, "Dérailleur déconnecté.", "NetworkError")
        if (notify && wasConnected) emit(JSONObject().put("type", "disconnect"))
    }

    private fun failConnect(message: String) {
        connectTimeout?.let { main.removeCallbacks(it) }
        val id = connectId ?: return
        connectId = null
        fail(id, message, "NetworkError")
    }

    // ---------------------------------------------------------------- Vers le JavaScript
    private fun ok(id: String) {
        emit(JSONObject().put("type", "result").put("id", id).put("ok", true))
    }

    private fun fail(id: String, message: String, code: String) {
        emit(JSONObject().put("type", "result").put("id", id).put("ok", false).put("error", message).put("code", code))
    }

    private fun emit(json: JSONObject) {
        val js = "window.__wheeltopNative && window.__wheeltopNative(${JSONObject.quote(json.toString())})"
        main.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
        // Nordic UART Service (PROTOCOL-APP.md:7-9)
        val SERVICE_UUID: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        val WRITE_UUID: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        val NOTIFY_UUID: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
