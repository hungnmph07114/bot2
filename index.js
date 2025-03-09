/********************************************
 *  BOT PHÂN TÍCH CRYPTO VỚI TÍNH NĂNG LƯU TRỮ SQL VÀ GIẢ LẬP
 *  (Sử dụng LSTM với WINDOW_SIZE, dynamic training control và lời khuyên đòn bẩy)
 ********************************************/

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, SMA, MACD, BollingerBands, ADX, ATR, Stochastic, OBV, IchimokuCloud } = require('technicalindicators');
const tf = require('@tensorflow/tfjs');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// =====================
//     CẤU HÌNH
// =====================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7644381153:AAGtd8uhtdPFbDqlpA9NAUSsIsePXQiO36g';
const BINANCE_API = 'https://api.binance.com/api/v3';
let adminChatId = null;

const timeframes = {
    '1m': '1 phút', 'm1': '1 phút', '3m': '3 phút', 'm3': '3 phút', '5m': '5 phút', 'm5': '5 phút',
    '15m': '15 phút', 'm15': '15 phút', '30m': '30 phút', 'm30': '30 phút', '1h': '1 giờ', 'h1': '1 giờ',
    '2h': '2 giờ', 'h2': '2 giờ', '4h': '4 giờ', 'h4': '4 giờ', '6h': '6 giờ', 'h6': '6 giờ',
    '8h': '8 giờ', 'h8': '8 giờ', '12h': '12 giờ', 'h12': '12 giờ', '1d': '1 ngày', 'd1': '1 ngày',
    '3d': '3 ngày', 'd3': '3 ngày', '1w': '1 tuần', 'w1': '1 tuần', '1M': '1 tháng', 'M1': '1 tháng'
};

function normalizeTimeframe(tfInput) {
    const mapping = {
        'm1': '1m', '1m': '1m', 'm3': '3m', '3m': '3m', 'm5': '5m', '5m': '5m', 'm15': '15m', '15m': '15m',
        'm30': '30m', '30m': '30m', 'h1': '1h', '1h': '1h', 'h2': '2h', '2h': '2h', 'h4': '4h', '4h': '4h',
        'h6': '6h', '6h': '6h', 'h8': '8h', '8h': '8h', 'h12': '12h', '12h': '12h', 'd1': '1d', '1d': '1d',
        'd3': '3d', '3d': '3d', 'w1': '1w', '1w': '1w', 'M1': '1M', '1M': '1M'
    };
    return mapping[tfInput] || null;
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Đường dẫn file
const BOT_DB_PATH = path.join(__dirname, 'bot.db');
const BOT_LOG_PATH = path.join(__dirname, 'bot.log');
const MODEL_DIR = path.join(__dirname, 'model');

// Lưu chatId của admin khi nhận tin nhắn đầu tiên
bot.on('message', (msg) => {
    if (!adminChatId) {
        adminChatId = msg.chat.id;
        console.log(`Admin chatId đã được thiết lập: ${adminChatId}`);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Admin chatId: ${adminChatId}\n`);
    }
});

// =====================
//  SQLITE - LƯU TRỮ DỮ LIỆU
// =====================
const db = new sqlite3.Database(BOT_DB_PATH, (err) => {
    if (err) {
        console.error('SQLite Error:', err.message);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi kết nối SQLite: ${err.message}\n`);
    } else {
        console.log('✅ Kết nối SQLite thành công.');
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - ✅ Kết nối SQLite thành công.\n`);
    }
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS watch_configs (
            chatId INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            pair TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            PRIMARY KEY (chatId, symbol, pair, timeframe)
        )`, (err) => {
        if (err) console.error('Lỗi tạo bảng watch_configs:', err.message);
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS signal_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            pair TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            signal TEXT NOT NULL,
            confidence INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            profit REAL
        )`, (err) => {
        if (err) console.error('Lỗi tạo bảng signal_history:', err.message);
    });

    // Thêm chỉ mục cho cột chatId và timestamp
    db.run(`CREATE INDEX IF NOT EXISTS idx_signal_history_chatId ON signal_history (chatId)`, (err) => {
        if (err) console.error('Lỗi tạo chỉ mục idx_signal_history_chatId:', err.message);
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_signal_history_timestamp ON signal_history (timestamp)`, (err) => {
        if (err) console.error('Lỗi tạo chỉ mục idx_signal_history_timestamp:', err.message);
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS user_settings (
            chatId INTEGER PRIMARY KEY,
            showTechnicalIndicators INTEGER DEFAULT 0
        )`, (err) => {
        if (err) console.error('Lỗi tạo bảng user_settings:', err.message);
    });
});

// =====================
//  HÀM HỖ TRỢ
// =====================
function addWatchConfig(chatId, symbol, pair, timeframe, callback) {
    db.run(
        `INSERT OR REPLACE INTO watch_configs (chatId, symbol, pair, timeframe) VALUES (?, ?, ?, ?)`,
        [chatId, symbol, pair, timeframe],
        callback
    );
}

function deleteWatchConfig(chatId, symbol, pair, timeframe, callback) {
    db.run(
        `DELETE FROM watch_configs WHERE chatId = ? AND symbol = ? AND pair = ? AND timeframe = ?`,
        [chatId, symbol, pair, timeframe],
        callback
    );
}

function loadWatchConfigs() {
    return new Promise((resolve, reject) => {
        db.all("SELECT chatId, symbol, pair, timeframe FROM watch_configs", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getUserSettings(chatId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT showTechnicalIndicators FROM user_settings WHERE chatId = ?`,
            [chatId],
            (err, row) => {
                if (err) reject(err);
                resolve(row ? row.showTechnicalIndicators : 0);
            }
        );
    });
}

function setUserSettings(chatId, showTechnicalIndicators) {
    db.run(
        `INSERT OR REPLACE INTO user_settings (chatId, showTechnicalIndicators) VALUES (?, ?)`,
        [chatId, showTechnicalIndicators],
        (err) => {
            if (err) console.error('Lỗi lưu cài đặt người dùng:', err.message);
        }
    );
}

// =====================
// CẤU HÌNH LSTM
// =====================
let currentConfig = {
    windowSize: 5,
    units: 32,
    epochs: 10
};

let bestConfig = { ...currentConfig };
let bestAccuracy = 0;
let recentAccuracies = [];
let lastAccuracy = 0;
let model;

function createModel(windowSize, units) {
    const model = tf.sequential();
    model.add(tf.layers.lstm({ units, inputShape: [windowSize, 20], returnSequences: false }));
    model.add(tf.layers.dense({ units: 10, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    return model;
}

async function optimizeModel() {
    if (recentAccuracies.length < 50) return;

    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    if (avgAcc > 0.7) return;

    console.log('⚙️ Bắt đầu tối ưu hóa mô hình...');
    fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Bắt đầu tối ưu hóa mô hình...\n`);

    const configsToTest = [
        { windowSize: 5, units: 32, epochs: 10 },
        { windowSize: 10, units: 64, epochs: 15 },
        { windowSize: 15, units: 128, epochs: 20 }
    ];

    for (const config of configsToTest) {
        console.log(`Thử cấu hình: ${JSON.stringify(config)}`);
        currentConfig = { ...config };
        recentAccuracies = [];
        const historicalData = await fetchKlines('BTC', 'USDT', '1h', 200);
        if (historicalData) {
            for (let i = currentConfig.windowSize; i < Math.min(historicalData.length, 50 + currentConfig.windowSize); i++) {
                await selfEvaluateAndTrain(historicalData.slice(0, i), i, historicalData, 'BTC', 'USDT', '1h');
            }
        }

        const newAvgAcc = recentAccuracies.length > 0 ? recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length : 0;
        console.log(`Độ chính xác trung bình với cấu hình ${JSON.stringify(config)}: ${(newAvgAcc * 100).toFixed(2)}%`);

        if (newAvgAcc > bestAccuracy) {
            bestAccuracy = newAvgAcc;
            bestConfig = { ...config };
        }
    }

    if (bestConfig) {
        Object.assign(currentConfig, bestConfig);
        console.log(`✅ Đã cập nhật tham số mô hình: ${JSON.stringify(currentConfig)}`);
    } else {
        console.log("⚠️ Không tìm thấy cấu hình tối ưu nào, giữ nguyên tham số hiện tại.");
    }
}

async function initializeModel() {
    model = createModel(currentConfig.windowSize, currentConfig.units);
    console.log('✅ LSTM model đã được khởi tạo');
}

async function trainModelData(data, symbol, pair, timeframe) {
    try {
        const inputs = [];
        const outputs = [];
        for (let i = currentConfig.windowSize; i < data.length; i++) {
            const windowFeatures = [];
            for (let j = i - currentConfig.windowSize; j < i; j++) {
                windowFeatures.push(computeFeature(data, j, symbol, pair, timeframe));
            }
            inputs.push(windowFeatures);

            const subData = data.slice(0, i + 1);
            const currentPrice = subData[subData.length - 1].close;
            const futureData = data.slice(i + 1, i + 11);
            let trueSignal = [0, 0, 1]; // WAIT
            if (futureData.length >= 10) {
                const futurePrice = futureData[futureData.length - 1].close;
                const priceChange = (futurePrice - currentPrice) / currentPrice * 100;
                if (priceChange > 0.5) trueSignal = [1, 0, 0]; // LONG
                else if (priceChange < -0.5) trueSignal = [0, 1, 0]; // SHORT
            }
            outputs.push(trueSignal);
        }
        if (inputs.length === 0) return;
        const xs = tf.tensor3d(inputs);
        const ys = tf.tensor2d(outputs);
        await model.fit(xs, ys, { epochs: currentConfig.epochs, batchSize: 32, shuffle: true });
        console.log(`✅ Mô hình đã được huấn luyện ban đầu với ${symbol}/${pair} (${timeframe}).`);
        xs.dispose();
        ys.dispose();
    } catch (error) {
        console.error(`Lỗi huấn luyện mô hình với ${symbol}/${pair} (${timeframe}):`, error.message);
    }
}

async function trainModelWithMultiplePairs() {
    const pairs = [
        { symbol: 'BTC', pair: 'USDT', timeframe: '1h' },
        { symbol: 'ADA', pair: 'USDT', timeframe: '1h' },
    ];

    for (const { symbol, pair, timeframe } of pairs) {
        const data = await fetchKlines(symbol, pair, timeframe, 500);
        if (data) {
            await trainModelData(data, symbol, pair, timeframe);
        } else {
            console.error(`❌ Không thể lấy dữ liệu ${symbol}/${pair} (${timeframe}) để huấn luyện.`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// =====================
// HÀM TÍNH CHỈ BÁO
// =====================
function computeRSI(close, period = 14) {
    const result = RSI.calculate({ values: close, period });
    return result.length > 0 ? result[result.length - 1] : 50;
}

function computeMA(close, period = 20) {
    const ma = SMA.calculate({ values: close, period });
    return ma.length > 0 ? ma[ma.length - 1] : 0;
}

function computeMACD(close) {
    const result = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    return result.length > 0 ? [result[result.length - 1].MACD || 0, result[result.length - 1].signal || 0, result[result.length - 1].histogram || 0] : [0, 0, 0];
}

function computeBollingerBands(close, period = 20, stdDev = 2) {
    const result = BollingerBands.calculate({ values: close, period, stdDev });
    return result.length > 0 ? [result[result.length - 1].upper || 0, result[result.length - 1].middle || 0, result[result.length - 1].lower || 0] : [0, 0, 0];
}

function computeADX(data, period = 14) {
    const result = ADX.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), period });
    return result.length > 0 ? result[result.length - 1].adx || 0 : 0;
}

function computeATR(data, period = 14) {
    const result = ATR.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), period });
    return result.length > 0 ? result[result.length - 1] || 0 : 0;
}

function computeStochastic(data, kPeriod = 14, dPeriod = 3, smooth = 3) {
    const result = Stochastic.calculate({
        high: data.map(d => d.high),
        low: data.map(d => d.low),
        close: data.map(d => d.close),
        period: kPeriod,
        signalPeriod: dPeriod,
        smooth
    });
    return result.length > 0 ? result[result.length - 1].k : 50;
}

function computeVWAP(data) {
    let totalVolume = 0;
    let totalPriceVolume = 0;
    for (const d of data) {
        const typicalPrice = (d.high + d.low + d.close) / 3;
        totalPriceVolume += typicalPrice * d.volume;
        totalVolume += d.volume;
    }
    return totalVolume > 0 ? totalPriceVolume / totalVolume : 0;
}

function computeOBV(data) {
    const result = OBV.calculate({ close: data.map(d => d.close), volume: data.map(d => d.volume) });
    return result.length > 0 ? result[result.length - 1] : 0;
}

function computeIchimoku(data) {
    const result = IchimokuCloud.calculate({
        high: data.map(d => d.high),
        low: data.map(d => d.low),
        close: data.map(d => d.close),
        conversionPeriod: 9,
        basePeriod: 26,
        spanPeriod: 52,
        displacement: 26
    });
    return result.length > 0 ? result[result.length - 1] : null;
}

function computeFibonacciLevels(data) {
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const diff = maxPrice - minPrice;
    return {
        0.236: maxPrice - diff * 0.236,
        0.382: maxPrice - diff * 0.382,
        0.5: maxPrice - diff * 0.5,
        0.618: maxPrice - diff * 0.618,
        0.786: maxPrice - diff * 0.786
    };
}

function computeSupportResistance(data) {
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);
    return { support: Math.min(...lows), resistance: Math.max(...highs) };
}

// =====================
// HÀM CHUẨN HÓA ONE-HOT ENCODING
// =====================
const symbolMap = new Map();
const pairMap = new Map();
const timeframeMap = new Map();
const EMBEDDING_SIZE = 3;

function getEmbedding(value, map) {
    if (!map.has(value)) {
        const embedding = Array.from({ length: EMBEDDING_SIZE }, () => Math.random());
        map.set(value, embedding);
    }
    return map.get(value);
}

function computeFeature(data, j, symbol, pair, timeframe) {
    if (!data || !data[j]) {
        console.error(`⚠️ computeFeature: Thiếu dữ liệu cho ${symbol}/${pair} (${timeframe}) tại index ${j}`);
        return Array(20).fill(0);
    }
    const subData = data.slice(0, j + 1);
    const close = subData.map(d => d.close);
    const volume = subData.map(d => d.volume);

    const rsi = computeRSI(close) || 50;
    const ma10 = computeMA(close, 10) || 0;
    const ma50 = computeMA(close, 50) || 0;
    const [, , histogram] = computeMACD(close) || [0, 0, 0];
    const [, middleBB] = computeBollingerBands(close) || [0, 0, 0];
    const adx = computeADX(subData) || 0;
    const stochasticK = computeStochastic(subData) || 50;
    const vwap = computeVWAP(subData) || 0;
    const obv = computeOBV(subData) || 0;
    const ichimoku = computeIchimoku(subData) || { conversionLine: 0, baseLine: 0 };
    const fibLevels = computeFibonacciLevels(subData) || { 0.618: 0 };
    const currentPrice = close[close.length - 1];
    const volumeMA = computeMA(volume, 20) || 0;
    const volumeSpike = volume[volume.length - 1] > volumeMA * 1.5 ? 1 : 0;
    const symbolEmbedding = getEmbedding(symbol, symbolMap);
    const pairEmbedding = getEmbedding(pair, pairMap);
    const timeframeEmbedding = getEmbedding(timeframe, timeframeMap);
    const safeDivide = (num, denom) => (denom !== 0 ? num / denom : 0);
    const features = [
        rsi / 100,
        adx / 100,
        safeDivide(histogram, Math.max(...close)),
        volumeSpike,
        safeDivide(ma10 - ma50, Math.max(...close)),
        safeDivide(currentPrice - middleBB, Math.max(...close)),
        stochasticK / 100,
        safeDivide(currentPrice - vwap, Math.max(...close)),
        obv / 1e6,
        ichimoku ? safeDivide(ichimoku.conversionLine - ichimoku.baseLine, Math.max(...close)) : 0,
        safeDivide(currentPrice - fibLevels[0.618], Math.max(...close)),
        ...symbolEmbedding,
        ...pairEmbedding,
        ...timeframeEmbedding
    ];

    const cleanFeatures = features.map(f => (isNaN(f) || f === undefined ? 0 : f));
    return cleanFeatures;
}

// =====================
// PHÂN TÍCH CRYPTO
// =====================
async function getCryptoAnalysis(symbol, pair, timeframe, chatId, customThresholds = {}) {
    const df = await fetchKlines(symbol, pair, timeframe);
    if (!df || df.length < currentConfig.windowSize) return { result: '❗ Không thể lấy dữ liệu', confidence: 0 };

    const windowFeatures = [];
    for (let i = df.length - currentConfig.windowSize; i < df.length; i++) {
        windowFeatures.push(computeFeature(df, i, symbol, pair, timeframe));
    }

    const currentPrice = df[df.length - 1].close;
    const closePrices = df.map(d => d.close);
    const volume = df.map(d => d.volume);
    const volumeMA = computeMA(volume, 20);
    const volumeSpike = volume[volume.length - 1] > volumeMA * 1.5 ? 1 : 0;
    const rsi = computeRSI(closePrices);
    const adx = computeADX(df);
    const [macd, signal, histogram] = computeMACD(closePrices);
    const [upperBB, middleBB, lowerBB] = computeBollingerBands(closePrices);
    let atr = computeATR(df);
    if (atr <= 0) atr = 0.0001;
    const stochasticK = computeStochastic(df);
    const vwap = computeVWAP(df);
    const obv = computeOBV(df);
    const ichimoku = computeIchimoku(df);
    const fibLevels = computeFibonacciLevels(df);
    const { support, resistance } = computeSupportResistance(df);
    const input = tf.tensor3d([windowFeatures]);
    const prediction = model.predict(input);
    const [longProb, shortProb, waitProb] = prediction.dataSync();
    input.dispose();
    prediction.dispose();

    let signalType = 'WAIT';
    let signalText = '⚪️ ĐỢI - Chưa có tín hiệu';
    let confidence, entry = currentPrice, sl = 0, tp = 0;
    const maxProb = Math.max(longProb, shortProb, waitProb);
    confidence = Math.round(maxProb * 100);

    if (maxProb === longProb) {
        signalType = 'LONG';
        signalText = '🟢 LONG - Mua';
        const slMultiplier = 3 - longProb * 2;
        const tpMultiplier = 2 + longProb * 4;
        sl = Math.max(currentPrice - atr * slMultiplier, support);
        tp = Math.min(currentPrice + atr * tpMultiplier, resistance);
        if (sl >= entry) sl = Math.max(entry - atr * 0.5, support);
        if (tp <= entry) tp = Math.min(entry + atr, resistance);
    } else if (maxProb === shortProb) {
        signalType = 'SHORT';
        signalText = '🔴 SHORT - Bán';
        const slMultiplier = 3 - shortProb * 2;
        const tpMultiplier = 2 + shortProb * 4;
        sl = Math.min(currentPrice + atr * slMultiplier, resistance);
        tp = Math.max(currentPrice - atr * tpMultiplier, support);
        if (sl <= entry) sl = Math.min(entry + atr * 0.5, resistance);
        if (tp >= entry) tp = Math.max(entry - atr, support);
    }

    const showTechnicalIndicators = await getUserSettings(chatId);

    const details = [];
    if (showTechnicalIndicators) {
        details.push(`📈 RSI: ${rsi.toFixed(1)}`);
        details.push(`🎯 Stochastic %K: ${stochasticK.toFixed(1)}`);
        details.push(`📊 VWAP: ${vwap.toFixed(4)}`);
        details.push(`📦 OBV: ${(obv / 1e6).toFixed(2)}M`);
        const isAboveCloud = ichimoku && currentPrice > Math.max(ichimoku.spanA, ichimoku.spanB);
        const isBelowCloud = ichimoku && currentPrice < Math.min(ichimoku.spanA, ichimoku.spanB);
        details.push(`☁️ Ichimoku: ${isAboveCloud ? 'Trên đám mây' : isBelowCloud ? 'Dưới đám mây' : 'Trong đám mây'}`);
        details.push(`📏 Fib Levels: 0.618: ${fibLevels[0.618].toFixed(4)}, 0.5: ${fibLevels[0.5].toFixed(4)}`);
    }
    details.push(`📦 Volume: ${volumeSpike ? 'TĂNG ĐỘT BIẾN' : 'BÌNH THƯỜNG'}`);
    details.push(`🛡️ Hỗ trợ: ${support.toFixed(4)}, Kháng cự: ${resistance.toFixed(4)}`);
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    details.push(`⏰ Thời gian: ${timestamp}`);

    if (adx < 20) details.push(`📊 Xu hướng: Đi ngang`);
    else if (longProb > shortProb) details.push(`📈 Xu hướng: Tăng (dự đoán AI)`);
    else if (shortProb > longProb) details.push(`📉 Xu hướng: Giảm (dự đoán AI)`);
    else details.push(`📊 Xu hướng: Không rõ`);

    if (signalType !== 'WAIT') {
        let risk, reward, rr;
        if (signalType === 'LONG') {
            risk = entry - sl;
            reward = tp - entry;
        } else {
            risk = sl - entry;
            reward = entry - tp;
        }
        if (risk > 0) {
            rr = (reward / risk).toFixed(2);
            details.push(`⚖️ R:R: ${rr}:1`);
        } else {
            details.push(`⚖️ R:R: N/A`);
        }
        details.push(`✅ Độ tin cậy: ${confidence}%`);
        details.push(`🎯 Điểm vào: ${entry.toFixed(4)}`);
        details.push(`🛑 SL: ${sl.toFixed(4)}`);
        details.push(`💰 TP: ${tp.toFixed(4)}`);
        const leverage = signalType === 'LONG' ? Math.round(longProb * 10) : Math.round(shortProb * 10);
        const safeLeverage = Math.min(leverage, 125);
        details.push(`💡 Khuyến nghị đòn bẩy: x${safeLeverage}`);
    }

    const resultText = `📊 *Phân tích ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})*\n`
        + `💰 Giá: ${currentPrice.toFixed(4)}\n`
        + `⚡️ *${signalText}*\n`
        + details.join('\n');

    return { result: resultText, confidence, signalType, signalText, entryPrice: entry, sl, tp };
}

// =====================
// SELF-EVALUATE & TRAIN
// =====================
let enableSimulation = true;
let trainingCounter = 0;
let shouldStopTraining = false;

async function selfEvaluateAndTrain(historicalSlice, currentIndex, fullData, symbol, pair, timeframe) {
    console.log(`Training check - shouldStopTraining: ${shouldStopTraining}, trainingCounter: ${trainingCounter}, Data length: ${historicalSlice?.length || 'null'}`);

    if (!historicalSlice) {
        console.log("🚫 Không thể huấn luyện: historicalSlice không hợp lệ.");
        return;
    }
    if (!fullData) {
        console.log("🚫 Không thể huấn luyện: fullData không hợp lệ.");
        return;
    }
    if (shouldStopTraining) {
        console.log("🚫 Không thể huấn luyện: Huấn luyện đã bị dừng (shouldStopTraining = true).");
        return;
    }
    if (historicalSlice.length < currentConfig.windowSize) {
        console.log(`🚫 Không thể huấn luyện: Số lượng dữ liệu (${historicalSlice.length}) nhỏ hơn windowSize (${currentConfig.windowSize}).`);
        return;
    }
    if (currentIndex + 11 > fullData.length) {
        console.log(`🚫 Không thể huấn luyện: Không đủ dữ liệu cho phần dự đoán (currentIndex: ${currentIndex}, fullData.length: ${fullData.length}).`);
        return;
    }

    const currentPrice = historicalSlice[historicalSlice.length - 1].close;
    const futureData = fullData.slice(currentIndex + 1, currentIndex + 11);
    const futurePrice = futureData.length >= 10 ? futureData[futureData.length - 1].close : null;
    if (!futurePrice) {
        console.log("🚫 Không thể huấn luyện: Không có dữ liệu giá tương lai đủ để tính toán.");
        return;
    }

    const priceChange = ((futurePrice - currentPrice) / currentPrice) * 100;
    let trueSignal = [0, 0, 1]; // WAIT
    if (priceChange > 0.5) trueSignal = [1, 0, 0]; // LONG
    else if (priceChange < -0.5) trueSignal = [0, 1, 0]; // SHORT

    const windowFeatures = [];
    for (let i = historicalSlice.length - currentConfig.windowSize; i < historicalSlice.length; i++) {
        windowFeatures.push(computeFeature(historicalSlice, i, symbol, pair, timeframe));
    }
    if (windowFeatures.some(f => f.some(v => isNaN(v)))) {
        console.error(`🚫 Dữ liệu chứa NaN, bỏ qua huấn luyện.`);
        return;
    }

    trainingCounter++;  // Vẫn giữ trainingCounter để theo dõi, nhưng không giới hạn

    try {
        const usedMemoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
        const batchSize = usedMemoryMB > 450 ? 8 : 16;
        const xs = tf.tensor3d([windowFeatures]);
        const ys = tf.tensor2d([trueSignal]);
        const history = await model.fit(xs, ys, { epochs: 1, batchSize, shuffle: true });
        xs.dispose();
        ys.dispose();

        const loss = history.history.loss[0];
        lastAccuracy = 1.0 - loss;
        recentAccuracies.push(lastAccuracy);
        if (recentAccuracies.length > 50) recentAccuracies.shift();

        console.log(`✅ Huấn luyện tại nến ${currentIndex} | RAM: ${usedMemoryMB.toFixed(2)} MB | Loss: ${loss.toFixed(4)} | Accuracy: ${(lastAccuracy * 100).toFixed(2)}%`);
    } catch (error) {
        console.error(`❌ Lỗi huấn luyện: ${error.message}`);
    }
}


// Báo cáo hiệu suất mô hình
function reportModelPerformance() {
    if (recentAccuracies.length < 50) return;
    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    const maxAcc = Math.max(...recentAccuracies);
    const minAcc = Math.min(...recentAccuracies);
    const message = `📊 *Hiệu suất mô hình LSTM*\n`
        + `Độ chính xác trung bình: ${(avgAcc * 100).toFixed(2)}%\n`
        + `Độ chính xác cao nhất: ${(maxAcc * 100).toFixed(2)}%\n`
        + `Độ chính xác thấp nhất: ${(minAcc * 100).toFixed(2)}%\n`
        + `Số lần huấn luyện: ${trainingCounter}`;
    if (adminChatId) {
        bot.sendMessage(adminChatId, message, { parse_mode: 'Markdown' });
    }
}
setInterval(reportModelPerformance, 60 * 60 * 1000); // Báo cáo mỗi giờ

function cleanupMemory() {
    const now = Date.now();
    for (const [key, value] of signalBuffer.entries()) {
        if (now - value.timestamp > 60 * 60 * 1000) {
            signalBuffer.delete(key);
        }
    }
    console.log(`🧹 Đã dọn dẹp bộ nhớ. Số tín hiệu trong buffer: ${signalBuffer.size}`);
}
setInterval(cleanupMemory, 30 * 60 * 1000); // Dọn dẹp mỗi 30 phút

// =====================
// CHẾ ĐỘ GIẢ LẬP
// =====================
let lastIndexMap = new Map();
let lastSignalTimestamps = {};
const SIGNAL_COOLDOWN = 10 * 60 * 1000;
const signalBuffer = new Map();
let apiErrorCounter = 0;

async function fetchKlines(symbol, pair, timeframe, limit = 500, retries = 3, delay = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(`${BINANCE_API}/klines`, {
                params: { symbol: `${symbol.toUpperCase()}${pair.toUpperCase()}`, interval: timeframe, limit },
                timeout: 10000,
            });
            if (!response || !response.data || !Array.isArray(response.data)) {
                throw new Error('Dữ liệu trả về từ API không hợp lệ');
            }
            const klines = response.data.map(d => ({
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5])
            }));
            const filteredKlines = klines.filter(k =>
                k.close > 0 && k.open > 0 && k.high > 0 && k.low > 0 && k.volume >= 0
            );
            console.log(`Fetched ${filteredKlines.length} klines for ${symbol}/${pair} (${timeframe})`);
            return filteredKlines;
        } catch (error) {
            let errorMessage = error.message;
            if (error.response) {
                errorMessage = `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
            }
            console.error(`API Error (${symbol}/${pair}, attempt ${attempt}/${retries}): ${errorMessage}`);
            fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - API Error: ${errorMessage}\n`);
            if (attempt === retries) return null;
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}

async function simulateTrade(symbol, pair, timeframe, signal, entryPrice, sl, tp, timestamp) {
    if (!signal || !['LONG', 'SHORT', 'WAIT'].includes(signal)) {
        console.error(`⚠️ simulateTrade: signal không hợp lệ (${signal}), bỏ qua giả lập.`);
        return { exitPrice: null, profit: null };
    }

    const data = await fetchKlines(symbol, pair, timeframe, 300);
    if (!data) return { exitPrice: null, profit: null };

    let exitPrice = null;
    let profit = null;

    for (let i = 0; i < data.length; i++) {
        if (data[i].timestamp <= timestamp) continue;
        const high = data[i].high;
        const low = data[i].low;

        if (signal === 'LONG') {
            if (low <= sl) {
                exitPrice = sl;
                profit = ((sl - entryPrice) / entryPrice) * 100;
                break;
            } else if (high >= tp) {
                exitPrice = tp;
                profit = ((tp - entryPrice) / entryPrice) * 100;
                break;
            }
        } else if (signal === 'SHORT') {
            if (high >= sl) {
                exitPrice = sl;
                profit = ((entryPrice - sl) / entryPrice) * 100;
                break;
            } else if (low <= tp) {
                exitPrice = tp;
                profit = ((entryPrice - tp) / entryPrice) * 100;
                break;
            }
        }
    }

    if (exitPrice === null) {
        exitPrice = data[data.length - 1].close;
        profit = signal === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
    }

    return { exitPrice, profit };
}

async function simulateConfig(config, stepInterval) {
    const { chatId, symbol, pair, timeframe } = config;
    const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;

    const valid = await isValidMarket(symbol, pair);
    if (!valid) {
        console.error(`❌ Cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} không hợp lệ, bỏ qua giả lập.`);
        return;
    }

    const historicalData = await fetchKlines(symbol, pair, timeframe);
    if (!historicalData) {
        console.error(`❌ Không thể lấy dữ liệu cho ${symbol}/${pair}, bỏ qua giả lập.`);
        apiErrorCounter++;
        if (apiErrorCounter >= 3 && adminChatId) {
            bot.sendMessage(adminChatId, `🚨 *Cảnh báo*: API Binance liên tục thất bại (3 lần liên tiếp). Vui lòng kiểm tra kết nối hoặc rate limit.`, { parse_mode: 'Markdown' });
            apiErrorCounter = 0;
        }
        return;
    }

    apiErrorCounter = 0;

    let currentIndex = lastIndexMap.has(configKey) ? lastIndexMap.get(configKey) : currentConfig.windowSize;

    async function simulateStep() {
        if (currentIndex >= historicalData.length || !enableSimulation) {
            console.log(`✅ Dừng giả lập ${symbol}/${pair} (${timeframes[timeframe]})`);
            lastIndexMap.delete(configKey);
            return;
        }
        try {
            console.log(`Simulate step - Index: ${currentIndex}, Data length: ${historicalData.length}`);
            const historicalSlice = historicalData.slice(0, currentIndex);
            if (historicalSlice.length < currentConfig.windowSize) {
                currentIndex++;
                setTimeout(simulateStep, stepInterval);
                return;
            }
            const { result, confidence, signalType, signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);
            const now = Date.now();
            if (!shouldStopTraining) await selfEvaluateAndTrain(historicalSlice, currentIndex, historicalData, symbol, pair, timeframe);
            lastIndexMap.set(configKey, currentIndex + 1);
            currentIndex++;
            setTimeout(simulateStep, stepInterval);
        } catch (error) {
            console.error(`Lỗi giả lập ${symbol}/${pair}: ${error.message}`);
            setTimeout(simulateStep, 30000);
        }
    }
    console.log(`Bắt đầu giả lập ${symbol}/${pair} (${timeframes[timeframe]}) từ nến ${currentIndex}...`);
    simulateStep();
}

async function simulateRealTimeForConfigs(stepInterval = 1000) {
    const configs = await loadWatchConfigs();
    if (!configs || configs.length === 0) {
        console.log('⚠️ Không có cấu hình watch nào để giả lập.');
        return;
    }
    for (let i = 0; i < configs.length; i++) {
        await simulateConfig(configs[i], stepInterval);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function isValidMarket(symbol, pair) {
    try {
        const response = await axios.get(`${BINANCE_API}/ticker/price`, {
            params: { symbol: `${symbol.toUpperCase()}${pair.toUpperCase()}` },
            timeout: 5000,
        });
        return !!response.data.price;
    } catch (error) {
        console.error(`Lỗi kiểm tra cặp ${symbol}/${pair}: ${error.message}`);
        return false;
    }
}

// =====================
// LỆNH BOT
// =====================
const autoWatchList = new Map();

bot.onText(/\?(.+)/, async (msg, match) => {
    try {
        const parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: ?ada,usdt,5m');

        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);
        if (!timeframes[timeframe]) return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ!`);

        const valid = await isValidMarket(symbol, pair);
        if (!valid) return bot.sendMessage(msg.chat.id, `⚠️ Cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} không tồn tại trên Binance!`);

        const chatId = msg.chat.id;
        const { result } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);
        bot.sendMessage(msg.chat.id, result, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi phân tích: ${error.message}`);
    }
});

bot.onText(/\/tinhieu (.+)/, async (msg, match) => {
    try {
        let parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) {
            parts = match[1].split(/\s+/).map(p => p.trim().toLowerCase());
            if (parts.length !== 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: /tinhieu ada,usdt,5m');
        }
        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);
        if (!timeframes[timeframe]) return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ!`);

        const valid = await isValidMarket(symbol, pair);
        if (!valid) return bot.sendMessage(msg.chat.id, `⚠️ Cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} không tồn tại trên Binance!`);

        const chatId = msg.chat.id;
        if (!autoWatchList.has(chatId)) autoWatchList.set(chatId, []);
        const watchList = autoWatchList.get(chatId);
        if (!watchList.some(w => w.symbol === symbol && w.pair === pair && w.timeframe === timeframe)) {
            watchList.push({ symbol, pair, timeframe });
            addWatchConfig(chatId, symbol, pair, timeframe, (err) => {
                if (err) console.error('Lỗi lưu cấu hình:', err.message);
            });
            bot.sendMessage(msg.chat.id, `✅ Đã bật theo dõi ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})`);
            const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;
            if (!lastIndexMap.has(configKey)) simulateConfig({ chatId, symbol, pair, timeframe }, 1000);
        } else {
            bot.sendMessage(msg.chat.id, 'ℹ️ Bạn đã theo dõi cặp này rồi!');
        }
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi /tinhieu: ${error.message}`);
    }
});

bot.onText(/\/dungtinhieu (.+)/, (msg, match) => {
    try {
        const parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: /dungtinhieu ada,usdt,5m');

        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);
        if (!timeframes[timeframe]) return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ!`);

        const chatId = msg.chat.id;
        if (!autoWatchList.has(chatId)) return bot.sendMessage(chatId, 'ℹ️ Bạn chưa theo dõi cặp nào.');

        const watchList = autoWatchList.get(chatId);
        const idx = watchList.findIndex(w => w.symbol === symbol && w.pair === pair && w.timeframe === timeframe);
        if (idx !== -1) {
            watchList.splice(idx, 1);
            deleteWatchConfig(chatId, symbol, pair, timeframe, (err) => {
                if (err) console.error('Lỗi xóa cấu hình:', err.message);
            });
            bot.sendMessage(msg.chat.id, `✅ Đã dừng theo dõi ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})`);
        } else {
            bot.sendMessage(msg.chat.id, 'ℹ️ Bạn chưa theo dõi cặp này!');
        }
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi /dungtinhieu: ${error.message}`);
    }
});

bot.onText(/\/lichsu/, (msg) => {
    const chatId = msg.chat.id;
    db.all(
        `SELECT symbol, pair, timeframe, signal, confidence, timestamp FROM signal_history WHERE chatId = ? ORDER BY timestamp DESC LIMIT 10`,
        [chatId],
        (err, rows) => {
            if (err) {
                console.error('Lỗi truy vấn lịch sử:', err.message);
                return bot.sendMessage(chatId, '❌ Lỗi khi lấy lịch sử tín hiệu.');
            }
            if (!rows || rows.length === 0) return bot.sendMessage(chatId, 'ℹ️ Chưa có lịch sử tín hiệu nào.');
            const historyText = rows.map(row => {
                const date = new Date(row.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                return `${row.symbol.toUpperCase()}/${row.pair.toUpperCase()} (${timeframes[row.timeframe]}): ${row.signal} (${row.confidence}%) - ${date}`;
            }).join('\n');
            bot.sendMessage(chatId, `📜 *LỊCH SỬ TÍN HIỆU (10 gần nhất)*\n${historyText}`, { parse_mode: 'Markdown' });
        }
    );
});

bot.onText(/\/tradehistory/, (msg) => {
    const chatId = msg.chat.id;
    db.all(
        `SELECT symbol, pair, timeframe, signal, entry_price, exit_price, profit, timestamp 
         FROM signal_history 
         WHERE chatId = ? AND entry_price IS NOT NULL 
         ORDER BY timestamp DESC LIMIT 10`,
        [chatId],
        (err, rows) => {
            if (err) {
                console.error('Lỗi truy vấn lịch sử giao dịch:', err.message);
                return bot.sendMessage(chatId, '❌ Lỗi khi lấy lịch sử giao dịch.');
            }
            if (!rows || rows.length === 0) return bot.sendMessage(chatId, 'ℹ️ Chưa có lịch sử giao dịch nào.');

            const historyText = rows.map(row => {
                const date = new Date(row.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                const profitText = row.profit !== null ? `${row.profit.toFixed(2)}%` : 'Đang chờ';
                return `${row.symbol.toUpperCase()}/${row.pair.toUpperCase()} (${timeframes[row.timeframe]}): ${row.signal}\n- Entry: ${row.entry_price.toFixed(4)}, Exit: ${row.exit_price ? row.exit_price.toFixed(4) : 'N/A'}, Profit: ${profitText}\n- ${date}`;
            }).join('\n\n');
            bot.sendMessage(chatId, `📜 *LỊCH SỬ GIAO DỊCH GIẢ LẬP (10 gần nhất)*\n\n${historyText}`, { parse_mode: 'Markdown' });
        }
    );
});



bot.onText(/\/trogiup/, (msg) => {
    const helpMessage = `
📚 *HƯỚNG DẪN SỬ DỤNG BOT GIAO DỊCH*
1. **?symbol,pair,timeframe** - Phân tích thủ công. Ví dụ: ?ada,usdt,5m
2. **/tinhieu symbol,pair,timeframe** - Bật theo dõi tự động. Ví dụ: /tinhieu ada,usdt,5m
3. **/dungtinhieu symbol,pair,timeframe** - Dừng theo dõi tự động. Ví dụ: /dungtinhieu ada,usdt,5m
4. **/lichsu** - Xem 10 tín hiệu gần nhất.
5. **/tradehistory** - Xem 10 giao dịch giả lập gần nhất.
6. **/status** - Xem trạng thái bot.
7. **/showindicators** và **/hideindicators** - Bật/tắt chỉ số kỹ thuật.
8. **/resettraining** - Đặt lại bộ đếm huấn luyện.
9. **/trogiup** - Hiển thị hướng dẫn này.
`;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/showindicators/, async (msg) => {
    const chatId = msg.chat.id;
    setUserSettings(chatId, 1);
    bot.sendMessage(chatId, '✅ Đã bật hiển thị chỉ số kỹ thuật.');
});

bot.onText(/\/hideindicators/, async (msg) => {
    const chatId = msg.chat.id;
    setUserSettings(chatId, 0);
    bot.sendMessage(chatId, '✅ Đã tắt hiển thị chỉ số kỹ thuật.');
});

bot.onText(/\/resettraining/, (msg) => {
    const chatId = msg.chat.id;
    trainingCounter = 0;
    shouldStopTraining = false;
    bot.sendMessage(chatId, '✅ Đã đặt lại bộ đếm huấn luyện và trạng thái dừng.');
    console.log(`✅ Đã đặt lại trainingCounter về 0 bởi chat ${chatId}`);
});

function startAutoChecking() {
    const CHECK_INTERVAL = 1 * 60 * 1000;
    setInterval(() => {
        for (const [chatId, watchList] of autoWatchList) {
            watchList.forEach(async (config) => {
                try {
                    await checkAutoSignal(chatId, config);
                } catch (err) {
                    console.error(`❌ Lỗi checkAutoSignal: ${err.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            });
        }
    }, CHECK_INTERVAL);
}

async function checkAutoSignal(chatId, { symbol, pair, timeframe }, confidenceThreshold = 70) {
    const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;
    const now = Date.now();

    const lastSignal = signalBuffer.get(configKey);
    const { result, confidence, signalType, signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);

    if (confidence < confidenceThreshold) return;

    const df = await fetchKlines(symbol, pair, timeframe, 50);
    const atr = df ? computeATR(df) : 0.0001;
    const priceChangeThreshold = atr * 0.5;

    if (lastSignal && Math.abs((entryPrice - lastSignal.entryPrice) / lastSignal.entryPrice) < priceChangeThreshold) {
        console.log(`⚠️ Giá thay đổi không đáng kể (${(priceChangeThreshold * 100).toFixed(2)}%), bỏ qua tín hiệu ${symbol}/${pair}.`);
        return;
    }

    if (lastSignal && now - lastSignal.timestamp < SIGNAL_COOLDOWN) {
        console.log(`⚠️ Tín hiệu ${symbol}/${pair} bị chặn do cooldown.`);
        return;
    }

    bot.sendMessage(chatId, `🚨 *TÍN HIỆU ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})* 🚨\n${result}`, { parse_mode: 'Markdown' });
    signalBuffer.set(configKey, { result, signalText, timestamp: now, entryPrice });

    const { exitPrice: rawExitPrice, profit: rawProfit } = await simulateTrade(symbol, pair, timeframe, signalType, entryPrice, sl, tp, now);

    if (lastSignal && lastSignal.signalText === signalText) {
        console.log(`⚠️ Tín hiệu ${symbol}/${pair} không thay đổi, không lưu vào database.`);
        return;
    }

    // Kiểm tra và xử lý giá trị null
    const safeChatId = chatId ?? 0; // Không bao giờ null, nhưng thêm để chắc chắn
    const safeSymbol = symbol ?? 'UNKNOWN';
    const safePair = pair ?? 'UNKNOWN';
    const safeTimeframe = timeframe ?? 'UNKNOWN';
    const safeSignal = signalType ?? 'UNKNOWN';
    const safeConfidence = confidence ?? 0;
    const safeTimestamp = now ?? Date.now();
    const safeEntryPrice = entryPrice ?? 0;
    const safeExitPrice = rawExitPrice ?? null; // Để null nếu không có giá thoát
    const safeProfit = rawProfit ?? null; // Để null nếu không có lợi nhuận

    // Kiểm tra các giá trị không được null
    if (!safeChatId || !safeSymbol || !safePair || !safeTimeframe || !safeSignal || safeConfidence === null || safeTimestamp === null || safeEntryPrice === null) {
        console.error(`❌ Dữ liệu không hợp lệ khi lưu tín hiệu ${safeSymbol}/${safePair}: `, {
            chatId: safeChatId, symbol: safeSymbol, pair: safePair, timeframe: safeTimeframe, signal: safeSignal,
            confidence: safeConfidence, timestamp: safeTimestamp, entryPrice: safeEntryPrice
        });
        return;
    }

    db.run(
        `INSERT INTO signal_history (chatId, symbol, pair, timeframe, signal, confidence, timestamp, entry_price, exit_price, profit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [safeChatId, safeSymbol, safePair, safeTimeframe, safeSignal, safeConfidence, safeTimestamp, safeEntryPrice, safeExitPrice, safeProfit],
        (err) => {
            if (err) {
                console.error(`❌ Lỗi lưu tín hiệu ${safeSymbol}/${safePair} vào database: ${err.message}`);
            } else {
                console.log(`✅ Gửi & lưu tín hiệu ${safeSymbol}/${safePair} cho chat ${safeChatId} (Độ tin: ${safeConfidence}%)`);
            }
        }
    );
}

// =====================
// DYNAMIC TRAINING CONTROL
// =====================
function dynamicTrainingControl() {
    if (recentAccuracies.length < 50) return;
    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    const maxAcc = Math.max(...recentAccuracies);
    const minAcc = Math.min(...recentAccuracies);

    if (avgAcc > 0.85 && (maxAcc - minAcc) < 0.05) {
        if (enableSimulation) {
            enableSimulation = false;
            shouldStopTraining = false; // Thêm dòng này nếu bạn muốn đặt lại trạng thái dừng
            trainingCounter = 0; // Đặt lại bộ đếm khi mô hình ổn định
            console.log("✅ Dynamic Training Control: Mô hình ổn định, dừng giả lập và đặt lại trainingCounter.");
            if (adminChatId) {
                bot.sendMessage(adminChatId, `✅ *Mô hình đã ổn định* | Accuracy: ${(avgAcc * 100).toFixed(2)}% | Đã dừng giả lập và đặt lại bộ đếm huấn luyện.`, { parse_mode: 'Markdown' });
            }
        }
    } else {
        if (!enableSimulation) {
            enableSimulation = true;
            console.log("⚡ Dynamic Training Control: Hiệu suất chưa ổn định, kích hoạt lại giả lập.");
            simulateRealTimeForConfigs(1000);
        } else {
            console.log("⚡ Dynamic Training Control: Hiệu suất chưa ổn định, tiếp tục giả lập.");
            simulateRealTimeForConfigs(1000);
        }
    }
}

// =====================
// KHỞI ĐỘNG BOT
// =====================
(async () => {
    await initializeModel();
    await trainModelWithMultiplePairs();
    startAutoChecking();
    await simulateRealTimeForConfigs(1000);
    setInterval(dynamicTrainingControl, 10 * 60 * 1000);
    setInterval(() => {
        console.log("⏳ Đang kiểm tra và tối ưu mô hình...");
        optimizeModel();
    }, 1 * 60 * 60 * 1000); // 5 giờ
})();
