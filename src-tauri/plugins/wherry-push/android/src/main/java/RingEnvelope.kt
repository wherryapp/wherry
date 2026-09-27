// The device's half of decision M-1 = E (docs/prompts/native-push-plan.md §2):
// a ring (the phone-calls plan's `call_ring` / `ring_ended`) reaches this
// install as RFC 8291 ciphertext, encrypted by the server's `encryptFor`
// (server/src/push/envelope.ts) to the P-256 public key and auth secret this
// plugin registered with its FCM token. Apple and Google relay bytes they
// cannot read; only the FCM data kind `k` travels beside them, for dispatch.
//
// Pure JCA, no Android API, so the JVM unit test (src/test) runs it against
// RFC 8291 Appendix A and against the server's own output. The steps are
// server/src/push/envelope.test.ts's reference `decrypt`, one for one:
//
//   body = salt (16) | rs (4, big-endian) | idlen (1) = 65 | keyid (65) = the
//          server's ephemeral public key | one record (AES-128-GCM, 16-byte tag)
//   ecdh = ECDH(our private key, keyid)
//   ikm  = HKDF(salt = auth, ikm = ecdh, info = "WebPush: info\0" | ours | keyid, 32)
//   cek  = HKDF(salt = salt, ikm, "Content-Encoding: aes128gcm\0", 16)
//   iv   = HKDF(salt = salt, ikm, "Content-Encoding: nonce\0", 12)
//   plaintext || 0x02 || 0x00* = AES-GCM-open(cek, iv, record)

package app.wherry.push

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Why a body could not be opened. The message never quotes key material. */
class EnvelopeException(message: String) : Exception(message)

object RingEnvelope {
  private const val SALT_LENGTH = 16
  private const val HEADER_LENGTH = SALT_LENGTH + 4 + 1
  private const val POINT_LENGTH = 65
  private const val TAG_LENGTH = 16
  private const val AUTH_LENGTH = 16

  /**
   * Opens one `aes128gcm` body addressed to this device.
   *
   * @param body the whole RFC 8188 body (the server sends it base64url; the
   *   caller decodes).
   * @param privateKey our P-256 private key.
   * @param publicPoint our public key as the 65-byte uncompressed point, the
   *   same bytes registered as `p256dh`.
   * @param auth the 16-byte auth secret registered as `auth`.
   * @throws EnvelopeException on any malformed body or failed tag.
   */
  fun open(body: ByteArray, privateKey: PrivateKey, publicPoint: ByteArray, auth: ByteArray): ByteArray {
    if (auth.size != AUTH_LENGTH) throw EnvelopeException("auth secret is not 16 bytes")
    if (publicPoint.size != POINT_LENGTH || publicPoint[0] != 0x04.toByte()) {
      throw EnvelopeException("public key is not an uncompressed P-256 point")
    }
    if (body.size < HEADER_LENGTH) throw EnvelopeException("body shorter than its header")

    val salt = body.copyOfRange(0, SALT_LENGTH)
    val rs = ((body[16].toLong() and 0xff) shl 24) or
      ((body[17].toLong() and 0xff) shl 16) or
      ((body[18].toLong() and 0xff) shl 8) or
      (body[19].toLong() and 0xff)
    val idlen = body[20].toInt() and 0xff
    if (idlen != POINT_LENGTH) throw EnvelopeException("keyid is not a P-256 point")
    if (body.size < HEADER_LENGTH + idlen + TAG_LENGTH + 1) {
      throw EnvelopeException("body has no record")
    }
    val senderPoint = body.copyOfRange(HEADER_LENGTH, HEADER_LENGTH + idlen)
    val record = body.copyOfRange(HEADER_LENGTH + idlen, body.size)
    // One record only: a ring is a few hundred bytes, and the server writes
    // one (RFC 8291 §4 allows no more for push).
    if (rs < TAG_LENGTH + 2 || record.size > rs) throw EnvelopeException("more than one record")

    val params = (privateKey as? ECPrivateKey)?.params
      ?: throw EnvelopeException("private key is not an EC key")
    val sender = publicKeyFromPoint(senderPoint, params)
    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(privateKey)
    agreement.doPhase(sender, true)
    val ecdhSecret = agreement.generateSecret()

    // RFC 8291 §3.4.
    val keyInfo = ascii("WebPush: info\u0000") + publicPoint + senderPoint
    val ikm = hkdf(auth, ecdhSecret, keyInfo, 32)
    // RFC 8188 §2.2 and §2.3.
    val cek = hkdf(salt, ikm, ascii("Content-Encoding: aes128gcm\u0000"), 16)
    val nonce = hkdf(salt, ikm, ascii("Content-Encoding: nonce\u0000"), 12)

    val padded = try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(TAG_LENGTH * 8, nonce))
      cipher.doFinal(record)
    } catch (e: Exception) {
      // AEADBadTagException and friends: the wrong key, or a tampered body.
      throw EnvelopeException("record did not authenticate")
    }

    // The last non-zero octet is the delimiter, 0x02 for the last record.
    var end = padded.size - 1
    while (end >= 0 && padded[end] == 0.toByte()) end -= 1
    if (end < 0 || padded[end] != 0x02.toByte()) throw EnvelopeException("no last-record delimiter")
    return padded.copyOfRange(0, end)
  }

  /** P-256 domain parameters, from a throwaway generated key. */
  fun p256Params(): ECParameterSpec {
    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"))
    return (generator.generateKeyPair().public as ECPublicKey).params
  }

  /** The 65-byte uncompressed encoding (`0x04 | x | y`) of a public key. */
  fun uncompressedPoint(key: ECPublicKey): ByteArray {
    val out = ByteArray(POINT_LENGTH)
    out[0] = 0x04
    fixed32(key.w.affineX).copyInto(out, 1)
    fixed32(key.w.affineY).copyInto(out, 33)
    return out
  }

  /** A public key from its uncompressed point; the provider rejects a point
   *  that is not on the curve when the key is used. */
  fun publicKeyFromPoint(point: ByteArray, params: ECParameterSpec): ECPublicKey {
    if (point.size != POINT_LENGTH || point[0] != 0x04.toByte()) {
      throw EnvelopeException("not an uncompressed P-256 point")
    }
    val x = BigInteger(1, point.copyOfRange(1, 33))
    val y = BigInteger(1, point.copyOfRange(33, 65))
    return try {
      KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params)) as ECPublicKey
    } catch (e: Exception) {
      throw EnvelopeException("point is not on P-256")
    }
  }

  /** HKDF-SHA-256 (RFC 5869), for outputs of at most one hash length. */
  internal fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
    require(length in 1..32)
    val prk = hmac(salt, ikm)
    return hmac(prk, info + byteArrayOf(0x01)).copyOfRange(0, length)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  private fun fixed32(value: BigInteger): ByteArray {
    val raw = value.toByteArray()
    return when {
      raw.size == 32 -> raw
      raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
      else -> ByteArray(32 - raw.size) + raw
    }
  }

  private fun ascii(text: String): ByteArray = text.toByteArray(Charsets.US_ASCII)
}
