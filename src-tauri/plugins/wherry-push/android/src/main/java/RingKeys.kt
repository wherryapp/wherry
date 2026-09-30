// The key pair rings are encrypted to (decision M-1 = E). The public half and
// the auth secret are what `status`, `register` and the `token` event report
// as `p256dh` and `auth` (unpadded base64url, hunk H3 of
// docs/prompts/native-push-plan.md §16), and what the page registers with the
// FCM token; the private half never leaves this process.
//
// Where it lives, and why it is wrapped: the private key and the auth secret
// are sealed with an AES-GCM key held in the Android Keystore, and only the
// sealed bytes go in SharedPreferences. The app itself is now out of Auto
// Backup and device transfer (`allowBackup="false"` and its data-extraction
// rules, hand edit 15), but that is a hand edit `tauri android init` would
// erase, and this file does not depend on it: without it SharedPreferences
// travel into a cloud backup or a device-to-device transfer, and a Keystore
// key never does. A restored copy therefore cannot be unsealed, which is the
// point: `load`
// then mints a fresh pair, the next `status` reports the new public half, and
// the page's once-per-launch registration hands it to the server (hunk H5).
// Rings sent to the old key in between are lost, which is the right failure
// for a key that moved to another device.
//
// Why not an ECDH key inside the Keystore itself: Keystore key agreement
// needs API 31, and minSdk is 24.

package app.wherry.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object RingKeys {
  private const val TAG = "wherry-push"
  private const val PREFS = "wherry-push"
  private const val PREF_PUBLIC = "ring.public"
  private const val PREF_SEALED = "ring.sealed"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val WRAP_ALIAS = "wherry-push-ring-wrap"
  private const val AUTH_LENGTH = 16
  private const val IV_LENGTH = 12

  class Material(val publicPoint: ByteArray, val auth: ByteArray, val privateKey: PrivateKey) {
    val p256dh: String get() = base64url(publicPoint)
    val authText: String get() = base64url(auth)
  }

  private var cached: Material? = null

  /** The current pair, minting one when there is none or the stored one
   *  cannot be unsealed. Null only if the Keystore itself is unusable. */
  @Synchronized
  fun load(context: Context): Material? {
    cached?.let { return it }
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val storedPublic = prefs.getString(PREF_PUBLIC, null)
    val storedSealed = prefs.getString(PREF_SEALED, null)
    if (storedPublic != null && storedSealed != null) {
      try {
        val sealed = Base64.decode(storedSealed, Base64.NO_WRAP)
        val opened = unseal(sealed)
        val auth = opened.copyOfRange(0, AUTH_LENGTH)
        val pkcs8 = opened.copyOfRange(AUTH_LENGTH, opened.size)
        val privateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))
        val material = Material(Base64.decode(storedPublic, Base64.NO_WRAP), auth, privateKey)
        cached = material
        return material
      } catch (e: Exception) {
        // A restored backup, a cleared Keystore, or a corrupt entry. Never
        // log the exception's message: some providers quote key bytes.
        Log.w(TAG, "ring key could not be unsealed (${e.javaClass.simpleName}); minting a new one")
      }
    }
    return try {
      mint(context)
    } catch (e: Exception) {
      Log.e(TAG, "ring key could not be minted (${e.javaClass.simpleName})")
      null
    }
  }

  /** Forgets the pair (Turn off); the next `load` mints a new one. */
  @Synchronized
  fun forget(context: Context) {
    cached = null
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .remove(PREF_PUBLIC).remove(PREF_SEALED).apply()
  }

  private fun mint(context: Context): Material {
    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"))
    val pair = generator.generateKeyPair()
    val publicPoint = RingEnvelope.uncompressedPoint(pair.public as ECPublicKey)
    val auth = ByteArray(AUTH_LENGTH).also { SecureRandom().nextBytes(it) }
    val sealed = seal(auth + pair.private.encoded)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(PREF_PUBLIC, Base64.encodeToString(publicPoint, Base64.NO_WRAP))
      .putString(PREF_SEALED, Base64.encodeToString(sealed, Base64.NO_WRAP))
      .commit()
    Log.i(TAG, "ring key minted")
    val material = Material(publicPoint, auth, pair.private)
    cached = material
    return material
  }

  private fun wrapKey(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAP_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  /** iv (12) | AES-GCM ciphertext and tag. */
  private fun seal(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
    val iv = cipher.iv
    check(iv.size == IV_LENGTH)
    return iv + cipher.doFinal(plain)
  }

  private fun unseal(sealed: ByteArray): ByteArray {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    val key = store.getKey(WRAP_ALIAS, null) as? SecretKey
      ?: throw IllegalStateException("no wrapping key")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed.copyOfRange(0, IV_LENGTH)))
    return cipher.doFinal(sealed.copyOfRange(IV_LENGTH, sealed.size))
  }

  /** Unpadded base64url: the server's register schema (87 and 22 characters). */
  fun base64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
