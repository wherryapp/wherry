// RingEnvelope on the JVM. Two vectors: RFC 8291 Appendix A (the standard
// itself), and one made by the server's own encryptFor
// (server/src/push/envelope.ts, 2026-09-27, with a throwaway device key), so
// the device and the server are shown to agree byte for byte, not only each
// with the RFC.

package app.wherry.push

import java.math.BigInteger
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RingEnvelopeTest {
  private fun b64(text: String): ByteArray = Base64.getUrlDecoder().decode(text)

  private fun privateKey(d: String): PrivateKey =
    KeyFactory.getInstance("EC")
      .generatePrivate(ECPrivateKeySpec(BigInteger(1, b64(d)), RingEnvelope.p256Params()))

  // RFC 8291 Appendix A.
  private val rfcBody = b64(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  )
  private val rfcPrivate = privateKey("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
  private val rfcPublic = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
  private val rfcAuth = b64("BTBZMqHH6r4Tts7J_aSIgg")

  // The server's encryptFor, over the phone-calls plan's §4.2 ring.
  private val serverBody = b64(
    "OYQK1QPerGBfFF2Bkdb_oAAAEABBBFi-xIrMBu0pr1xrCKrLn1uCB2GJHkqBmov3T1nYENQljSVlyTJpUAIQ6cHHDC4flfSNDtS7gSoVwPPUZwS6-cgU3WQlK0AlPHbtmuep46t2QnR_an41i4ceHKp-e9Mn9yb8m28HNI_G2yJV8R25KM6gnH6ltx8kOqC04Unib0OG2TPK-F-OxXs4PAOlrSoDPpV_cDqSh_3hKdeRnDg_hbDTqRRdQpqFPAPxlnuKM2OhSBRM2r3hMo1mUUGF6AoQ9Hf9W1R0m6g4cOlpIm09Bh07YiGaJHl35duZMph1wyuMvu87Smcws_ya-muiUwEYHmwC32jH-4GErgN2sXHqgCEZNmo8hS0puHumesN_P1yycVKgECl0sgqjBxQcKSVXkbmRB7T1_GUnp0wmS_ROKVeweA",
  )
  private val serverPrivate = privateKey("rm3mcLkL1LlSte950sAvtUXidp6vncXU4k0-29JXB7A")
  private val serverPublic = b64("BEchEPHpCkdA-7jrh0f2MjeW3vb4HuKVmIVy8bp4qz68zsljEFPi7Pn670pN-SkRYiqhud4xsN8R_QUv_vXWuSc")
  private val serverAuth = b64("_JIwGgBFApEFiLM6Qzx6PA")
  private val serverPlaintext =
    "{\"w\":1,\"k\":\"call_ring\",\"call\":\"0192f3a0-0000-7000-8000-00000000000c\"," +
      "\"conv\":\"0192f3a0-0000-7000-8000-000000000001\",\"dev\":\"0192f3a0-0000-7000-8000-0000000000d1\"," +
      "\"group\":false,\"exp\":1790000045,\"dsig\":\"c2lnbmF0dXJlLW5vdC1yZWFs\"}"

  @Test
  fun opensRfc8291AppendixA() {
    val plaintext = RingEnvelope.open(rfcBody, rfcPrivate, rfcPublic, rfcAuth)
    assertEquals("When I grow up, I want to be a watermelon", String(plaintext, Charsets.UTF_8))
  }

  @Test
  fun opensWhatTheServerEncrypts() {
    val plaintext = RingEnvelope.open(serverBody, serverPrivate, serverPublic, serverAuth)
    assertEquals(serverPlaintext, String(plaintext, Charsets.UTF_8))
  }

  @Test
  fun refusesTheWrongAuthSecret() {
    val wrong = serverAuth.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
    assertThrows(EnvelopeException::class.java) {
      RingEnvelope.open(serverBody, serverPrivate, serverPublic, wrong)
    }
  }

  @Test
  fun refusesAnotherDevicesKey() {
    assertThrows(EnvelopeException::class.java) {
      RingEnvelope.open(serverBody, rfcPrivate, rfcPublic, serverAuth)
    }
  }

  @Test
  fun refusesATamperedRecord() {
    val tampered = serverBody.copyOf().also { it[it.size - 20] = (it[it.size - 20].toInt() xor 1).toByte() }
    assertThrows(EnvelopeException::class.java) {
      RingEnvelope.open(tampered, serverPrivate, serverPublic, serverAuth)
    }
  }

  @Test
  fun refusesATruncatedBody() {
    assertThrows(EnvelopeException::class.java) {
      RingEnvelope.open(serverBody.copyOfRange(0, 90), serverPrivate, serverPublic, serverAuth)
    }
  }

  @Test
  fun refusesAKeyIdThatIsNotAPoint() {
    val bad = serverBody.copyOf().also { it[20] = 64 }
    assertThrows(EnvelopeException::class.java) {
      RingEnvelope.open(bad, serverPrivate, serverPublic, serverAuth)
    }
  }

  @Test
  fun encodesAPublicKeyAsTheRegisteredPoint() {
    val key = RingEnvelope.publicKeyFromPoint(serverPublic, RingEnvelope.p256Params())
    assertArrayEquals(serverPublic, RingEnvelope.uncompressedPoint(key))
    assertEquals(87, Base64.getUrlEncoder().withoutPadding().encodeToString(serverPublic).length)
  }

  @Test
  fun hkdfMatchesRfc5869TestCase1() {
    // RFC 5869 A.1, truncated to the one-block outputs this code uses.
    val ikm = ByteArray(22) { 0x0b }
    val salt = ByteArray(13) { it.toByte() }
    val info = ByteArray(10) { (0xf0 + it).toByte() }
    val okm = RingEnvelope.hkdf(salt, ikm, info, 32)
    assertEquals(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
      okm.joinToString("") { "%02x".format(it) },
    )
  }
}
