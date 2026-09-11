import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Generates the AES interop fixtures in test/fixtures/java-vectors.json.
 *
 * The lines that matter are lifted verbatim from the Pesepay server's
 * PaymentPayloadEncryptionHelper (pesepay-payments-engine/encryption):
 *
 *     val initializingVector = key.substring(0, 16);
 *     IvParameterSpec iv = new IvParameterSpec(initializingVector.getBytes(StandardCharsets.UTF_8));
 *     SecretKeySpec secretKeySpec = new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES");
 *     Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5PADDING");
 *     return Base64.getEncoder().encodeToString(cipher.doFinal(target.getBytes()));
 *
 * key.substring(0, 16) is a *char* operation, which is why the SDK asserts the
 * key is 32 ASCII characters: for a key outside ASCII, Java's 16 chars and
 * Node's 16 bytes are different bytes and the two sides silently desync.
 *
 * Run (JDK 17+, single-file source mode, no Maven needed) from the repo root:
 *
 *     java scripts/java/GenerateVectors.java test/fixtures/java-vectors.json
 *
 * These vectors are the *reference*. Never regenerate them from the Node
 * implementation - that would turn an interop test into a tautology.
 */
public final class GenerateVectors {

    private static final String TRANSFORMATION = "AES/CBC/PKCS5PADDING";
    private static final String ALGORITHM = "AES";

    /** Hex-UUID shaped, exactly like the keys the Pesepay dashboard issues. */
    private static final String KEY_A = "3d2f8c1a4b6e7f905a1c2d3e4f506172";
    private static final String KEY_B = "a0b1c2d3e4f5061728394a5b6c7d8e9f";

    private record Vector(String name, String note, String key, String plaintext) {}

    public static void main(String[] args) throws Exception {

        if (args.length != 1) {
            System.err.println("usage: java GenerateVectors.java <output.json>");
            System.exit(2);
        }

        List<Vector> vectors = new ArrayList<>();

        vectors.add(new Vector("empty-string",
                "Zero-length input still produces one full block of PKCS#7 padding.",
                KEY_A, ""));

        vectors.add(new Vector("single-byte",
                "Shortest non-empty input; 15 bytes of padding.",
                KEY_A, "a"));

        vectors.add(new Vector("block-minus-one",
                "15 bytes: a single padding byte, the tightest fit.",
                KEY_A, "0123456789abcde"));

        vectors.add(new Vector("exact-one-block",
                "Exactly 16 bytes. PKCS#7 must append a WHOLE extra block of 0x10 bytes; an "
                        + "implementation that pads only when there is a remainder produces 16 bytes "
                        + "of ciphertext here instead of 32.",
                KEY_A, "0123456789abcdef"));

        vectors.add(new Vector("exact-two-blocks",
                "Exactly 32 bytes - the same full-padding-block trap one block further out.",
                KEY_A, "{\"amount\":10.50,\"code\":\"USD\"}==="));

        vectors.add(new Vector("initiate-transaction-request",
                "A real /v1/payments/initiate request body as the SDK serialises it.",
                KEY_A,
                "{\"amountDetails\":{\"amount\":10.5,\"currencyCode\":\"USD\"},\"reasonForPayment\":\"Order 1234\","
                        + "\"merchantReference\":\"ORD-1234\",\"transactionType\":\"BASIC\","
                        + "\"resultUrl\":\"https://example.com/pesepay/result\","
                        + "\"returnUrl\":\"https://example.com/pesepay/return\"}"));

        vectors.add(new Vector("payment-transaction-result",
                "A real decrypted PaymentTransactionResult, carrying the transactionStatus the SDK surfaces.",
                KEY_A,
                "{\"referenceNumber\":\"RN123456789\",\"transactionStatus\":\"SUCCESS\",\"transactionStatusCode\":304,"
                        + "\"transactionStatusDescription\":\"Transaction was successfully completed\","
                        + "\"amountDetails\":{\"amount\":10.5,\"currencyCode\":\"USD\",\"totalTransactionAmount\":10.5},"
                        + "\"pollUrl\":\"https://api.pesepay.com/api/payments-engine/v1/payments/"
                        + "check-payment?referenceNumber=RN123456789\"}"));

        vectors.add(new Vector("non-ascii-plaintext",
                "Multi-byte UTF-8 in the PLAINTEXT is fine - both sides encode UTF-8. Only the KEY "
                        + "must be ASCII, because Java derives the IV by chars and Node by bytes.",
                // Escaped rather than literal so this generator emits identical bytes
                // regardless of the platform's javac source encoding.
                KEY_A, "{\"name\":\"Tafadzwa M\u00fcller\",\"note\":\"paid \u2014 \u2713 \u20ac10\"}"));

        vectors.add(new Vector("second-key",
                "Identical plaintext under a different key, so a hardcoded key or IV cannot pass.",
                KEY_B, "0123456789abcdef"));

        vectors.add(new Vector("large-payload",
                "2 KiB of metadata, well past a single cipher update.",
                KEY_B, "{\"paymentMetadata\":{\"blob\":\"" + "Lorem ipsum dolor sit amet. ".repeat(74) + "\"}}"));

        StringBuilder out = new StringBuilder();
        out.append("{\n");
        out.append("  \"$comment\": [\n");
        out.append("    ").append(json(
                "AES interop vectors produced by the Java Pesepay server's own cipher path.")).append(",\n");
        out.append("    ").append(json(
                "Generated by scripts/java/GenerateVectors.java, which mirrors PaymentPayloadEncryptionHelper.")).append(",\n");
        out.append("    ").append(json(
                "DO NOT regenerate these from the Node implementation: they exist to prove Node agrees with Java.")).append("\n");
        out.append("  ],\n");

        out.append("  \"generator\": {\n");
        out.append("    \"script\": ").append(json("scripts/java/GenerateVectors.java")).append(",\n");
        out.append("    \"reference\": ").append(json("pesepay-payments-engine/encryption/src/main/java/"
                + "com/pesepay/paymentsengine/encryption/PaymentPayloadEncryptionHelper.java")).append(",\n");
        out.append("    \"javaVersion\": ").append(json(System.getProperty("java.version"))).append(",\n");
        out.append("    \"javaVendor\": ").append(json(System.getProperty("java.vendor"))).append(",\n");
        out.append("    \"fileEncoding\": ").append(json(System.getProperty("file.encoding"))).append(",\n");
        out.append("    \"generatedAt\": ").append(json(Instant.now().toString())).append("\n");
        out.append("  },\n");

        out.append("  \"algorithm\": {\n");
        out.append("    \"transformation\": ").append(json(TRANSFORMATION)).append(",\n");
        out.append("    \"nodeAlgorithm\": ").append(json("aes-256-cbc")).append(",\n");
        out.append("    \"keyDerivation\": ").append(json(
                "SecretKeySpec over the key's UTF-8 bytes (32 chars => 32 bytes => AES-256)")).append(",\n");
        out.append("    \"ivDerivation\": ").append(json(
                "key.substring(0, 16) as UTF-8 bytes - a CHAR slice, hence the ASCII requirement")).append(",\n");
        out.append("    \"padding\": ").append(json("PKCS#5 == PKCS#7 at a 16-byte block size")).append(",\n");
        out.append("    \"encoding\": ").append(json("standard base64 with padding, not base64url")).append("\n");
        out.append("  },\n");

        out.append("  \"vectors\": [\n");
        for (int i = 0; i < vectors.size(); i++) {
            Vector v = vectors.get(i);
            byte[] plainBytes = v.plaintext().getBytes(StandardCharsets.UTF_8);
            String ciphertext = encrypt(v.key(), v.plaintext());
            int cipherLen = Base64.getDecoder().decode(ciphertext).length;

            // Self-check: PKCS#7 always grows to the next strictly-larger multiple of 16.
            int expected = plainBytes.length + 16 - (plainBytes.length % 16);
            if (cipherLen != expected) {
                throw new IllegalStateException("padding invariant broken for " + v.name());
            }

            out.append("    {\n");
            out.append("      \"name\": ").append(json(v.name())).append(",\n");
            out.append("      \"note\": ").append(json(v.note())).append(",\n");
            out.append("      \"key\": ").append(json(v.key())).append(",\n");
            out.append("      \"plaintext\": ").append(json(v.plaintext())).append(",\n");
            out.append("      \"plaintextByteLength\": ").append(plainBytes.length).append(",\n");
            out.append("      \"ciphertextBase64\": ").append(json(ciphertext)).append(",\n");
            out.append("      \"ciphertextByteLength\": ").append(cipherLen).append("\n");
            out.append("    }").append(i == vectors.size() - 1 ? "\n" : ",\n");
        }
        out.append("  ],\n");

        // A ciphertext whose final byte has been altered. AES-CBC carries no
        // integrity protection, so the only thing that catches this is the
        // PKCS#7 padding check on the last block - which must surface as a
        // thrown error rather than silently-returned garbage.
        String tamperPlaintext = "{\"transactionStatus\":\"FAILED\"}";
        String tamperSource = encrypt(KEY_A, tamperPlaintext);
        byte[] raw = Base64.getDecoder().decode(tamperSource);
        byte[] tampered = raw.clone();
        tampered[tampered.length - 1] ^= 0x01;

        out.append("  \"tampered\": {\n");
        out.append("    \"note\": ").append(json(
                "Last ciphertext byte flipped. Decryption must THROW on the PKCS#7 padding check, "
                        + "never return garbage - a payments SDK that silently accepts a mangled "
                        + "transactionStatus is worse than one that fails loudly.")).append(",\n");
        out.append("    \"key\": ").append(json(KEY_A)).append(",\n");
        out.append("    \"originalPlaintext\": ").append(json(tamperPlaintext)).append(",\n");
        out.append("    \"validCiphertextBase64\": ").append(json(tamperSource)).append(",\n");
        out.append("    \"tamperedCiphertextBase64\": ").append(json(
                Base64.getEncoder().encodeToString(tampered))).append("\n");
        out.append("  }\n");
        out.append("}\n");

        Path target = Path.of(args[0]);
        Files.writeString(target, out.toString(), StandardCharsets.UTF_8);

        PrintStream log = System.out;
        log.printf("wrote %d vectors + 1 tampered case to %s%n", vectors.size(), target.toAbsolutePath());
        log.printf("java %s (%s), file.encoding=%s%n",
                System.getProperty("java.version"), System.getProperty("java.vendor"),
                System.getProperty("file.encoding"));
    }

    private static String encrypt(String key, String target) throws Exception {
        String initializingVector = key.substring(0, 16);
        IvParameterSpec iv = new IvParameterSpec(initializingVector.getBytes(StandardCharsets.UTF_8));
        SecretKeySpec secretKeySpec = new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), ALGORITHM);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, secretKeySpec, iv);
        return Base64.getEncoder().encodeToString(cipher.doFinal(target.getBytes(StandardCharsets.UTF_8)));
    }

    /** Emits pure-ASCII JSON strings so the committed fixture is byte-stable everywhere. */
    private static String json(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20 || c > 0x7e) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.append('"').toString();
    }
}
