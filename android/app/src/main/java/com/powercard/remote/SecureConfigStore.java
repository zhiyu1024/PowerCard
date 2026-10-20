package com.powercard.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 配置的加密存储：SharedPreferences + Android Keystore AES/GCM。
 *
 * <p>落盘格式为 Base64([1 字节 IV 长度][IV][密文+16 字节 GCM tag])，密钥常驻
 * Android Keystore（不可导出）。配置损坏、密钥失效或从未保存时统一返回 "{}"，
 * 让 JS 侧回落到默认配置；本类不打印任何配置内容（URL/token 不写日志）。</p>
 */
final class SecureConfigStore {

    private static final String PREFS_NAME = "powercard_secure_config";
    private static final String PREF_KEY = "config_v1";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "powercard_config_key_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final String EMPTY_JSON = "{}";
    private static final int MAX_JSON_CHARS = 64 * 1024;

    private final SharedPreferences preferences;
    private final SecureRandom secureRandom = new SecureRandom();
    private SecretKey cachedKey;

    SecureConfigStore(Context context) {
        this.preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** 读取配置 JSON；任何异常都返回 "{}"。同步方法，由 JS 接口线程调用。 */
    synchronized String load() {
        String blob = preferences.getString(PREF_KEY, null);
        if (blob == null || blob.isEmpty()) {
            return EMPTY_JSON;
        }
        try {
            byte[] packed = Base64.decode(blob, Base64.NO_WRAP);
            int ivLength = packed[0] & 0xFF;
            if (ivLength <= 0 || ivLength > 32 || packed.length <= 1 + ivLength) {
                return EMPTY_JSON;
            }
            byte[] iv = Arrays.copyOfRange(packed, 1, 1 + ivLength);
            byte[] cipherText = Arrays.copyOfRange(packed, 1 + ivLength, packed.length);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(cipherText);
            String json = new String(plain, StandardCharsets.UTF_8);
            return isJsonObject(json) ? json : EMPTY_JSON;
        } catch (Throwable ignored) {
            // 损坏数据 / 密钥被清除 / Keystore 不可用：按“无配置”处理
            return EMPTY_JSON;
        }
    }

    /** 保存配置 JSON；非法输入返回 false。同步方法，由 JS 接口线程调用。 */
    synchronized boolean save(String json) {
        if (!isJsonObject(json) || json.length() > MAX_JSON_CHARS) {
            return false;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length == 0 || iv.length > 32) {
                return false;
            }
            byte[] cipherText = cipher.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] packed = new byte[1 + iv.length + cipherText.length];
            packed[0] = (byte) iv.length;
            System.arraycopy(iv, 0, packed, 1, iv.length);
            System.arraycopy(cipherText, 0, packed, 1 + iv.length, cipherText.length);
            return preferences.edit()
                    .putString(PREF_KEY, Base64.encodeToString(packed, Base64.NO_WRAP))
                    .commit();
        } catch (Throwable ignored) {
            return false;
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        if (cachedKey != null) {
            return cachedKey;
        }
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            cachedKey = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            return cachedKey;
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build();
        generator.init(spec);
        cachedKey = generator.generateKey();
        return cachedKey;
    }

    private static boolean isJsonObject(String json) {
        if (json == null) {
            return false;
        }
        String trimmed = json.trim();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            return false;
        }
        try {
            new JSONObject(trimmed);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }
}
