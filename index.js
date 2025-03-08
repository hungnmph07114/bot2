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

// Đường dẫn file tương thích cả cục bộ và Railway
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
        if (err) {
            console.error('Lỗi tạo bảng watch_configs:', err.message);
            fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi tạo bảng watch_configs: ${err.message}\n`);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS signal_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId INTEGER,
            symbol TEXT,
            pair TEXT,
            timeframe TEXT,
            signal TEXT,
            confidence INTEGER,
            timestamp INTEGER,
            entry_price REAL,
            exit_price REAL,
            profit REAL
        )`, (err) => {
        if (err) {
            console.error('Lỗi tạo bảng signal_history:', err.message);
            fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi tạo bảng signal_history: ${err.message}\n`);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS user_settings (
            chatId INTEGER PRIMARY KEY,
            showTechnicalIndicators INTEGER DEFAULT 0
        )`, (err) => {
        if (err) {
            console.error('Lỗi tạo bảng user_settings:', err.message);
            fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi tạo bảng user_settings: ${err.message}\n`);
        }
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

// Xuất file bot.db
function exportDatabase(chatId) {
    return new Promise((resolve, reject) => {
        bot.sendDocument(chatId, BOT_DB_PATH, { caption: 'Đây là file cơ sở dữ liệu bot.db' })
            .then(() => resolve())
            .catch((err) => reject(err));
    });
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

// Hàm lưu mô hình thủ công
async function saveModel(model) {
    try {
        if (!fs.existsSync(MODEL_DIR)) {
            fs.mkdirSync(MODEL_DIR, { recursive: true });
        }

        // Lưu cấu trúc mô hình dưới dạng JSON
        const modelTopology = model.toJSON();
        fs.writeFileSync(
            path.join(MODEL_DIR, 'model.json'),
            JSON.stringify(modelTopology, null, 2)
        );

        // Lưu tất cả trọng số dưới dạng mảng Float32Array và ghi vào file nhị phân
        const weights = model.getWeights();
        const weightSpecs = [];
        const weightDataArray = [];

        for (let i = 0; i < weights.length; i++) {
            const tensorData = await weights[i].data(); // Lấy dữ liệu tensor dưới dạng Float32Array
            weightSpecs.push({
                name: weights[i].name,
                shape: weights[i].shape,
                dtype: weights[i].dtype,
            });
            weightDataArray.push(tensorData);
        }

        // Gộp tất cả dữ liệu trọng số thành một buffer nhị phân
        const totalLength = weightDataArray.reduce((sum, data) => sum + data.length, 0);
        const weightBuffer = new Float32Array(totalLength);
        let offset = 0;
        for (const data of weightDataArray) {
            weightBuffer.set(data, offset);
            offset += data.length;
        }

        // Lưu trọng số và thông tin cấu hình
        fs.writeFileSync(
            path.join(MODEL_DIR, 'weights.bin'),
            Buffer.from(weightBuffer.buffer)
        );
        fs.writeFileSync(
            path.join(MODEL_DIR, 'weights_spec.json'),
            JSON.stringify(weightSpecs, null, 2)
        );

        console.log('✅ Mô hình đã được lưu thủ công.');
    } catch (error) {
        console.error('Lỗi lưu mô hình thủ công:', error.message);
    }
}

// Hàm tải mô hình thủ công
async function loadModel() {
    try {
        const modelPath = path.join(MODEL_DIR, 'model.json');
        const weightsPath = path.join(MODEL_DIR, 'weights.bin');
        const weightsSpecPath = path.join(MODEL_DIR, 'weights_spec.json');

        if (!fs.existsSync(modelPath) || !fs.existsSync(weightsPath) || !fs.existsSync(weightsSpecPath)) {
            console.log('⚠️ Không tìm thấy mô hình, tạo mới.');
            return createModel(currentConfig.windowSize, currentConfig.units);
        }

        // Tải cấu trúc mô hình từ JSON
        const modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
        const loadedModel = await tf.models.modelFromJSON(modelJson);

        // Tải thông tin cấu hình trọng số
        const weightSpecs = JSON.parse(fs.readFileSync(weightsSpecPath, 'utf8'));
        const weightBuffer = fs.readFileSync(weightsPath);
        const weightData = new Float32Array(weightBuffer.buffer);

        // Tái tạo các tensor trọng số từ dữ liệu nhị phân
        const weightTensors = [];
        let offset = 0;
        for (const spec of weightSpecs) {
            const numElements = spec.shape.reduce((a, b) => a * b, 1);
            const tensorData = weightData.slice(offset, offset + numElements);
            weightTensors.push(tf.tensor(tensorData, spec.shape, spec.dtype));
            offset += numElements;
        }

        // Gán trọng số vào mô hình
        loadedModel.setWeights(weightTensors);

        console.log('✅ Đã tải mô hình từ file thủ công.');
        return loadedModel;
    } catch (error) {
        console.error('Lỗi tải mô hình thủ công:', error.message);
        return createModel(currentConfig.windowSize, currentConfig.units);
    }
}

// Hàm tạo mô hình
function createModel(windowSize, units) {
    const model = tf.sequential();
    model.add(tf.layers.lstm({ units, inputShape: [windowSize, 11], returnSequences: false }));
    model.add(tf.layers.dense({ units: 10, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    return model;
}

// Hàm tính đặc trưng (feature) từ dữ liệu
function computeFeature(data, index) {
    const closePrices = data.slice(0, index + 1).map(d => d.close);
    const highPrices = data.slice(0, index + 1).map(d => d.high);
    const lowPrices = data.slice(0, index + 1).map(d => d.low);
    const volumes = data.slice(0, index + 1).map(d => d.volume);

    const rsi = RSI.calculate({ values: closePrices, period: 14 })[RSI.calculate({ values: closePrices, period: 14 }).length - 1] || 0;
    const sma = SMA.calculate({ values: closePrices, period: 20 })[SMA.calculate({ values: closePrices, period: 20 }).length - 1] || 0;
    const macdResult = MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const macd = macdResult[macdResult.length - 1]?.MACD || 0;

    return [
        data[index].open,
        data[index].high,
        data[index].low,
        data[index].close,
        data[index].volume,
        rsi,
        sma,
        macd,
        highPrices[highPrices.length - 1] - lowPrices[lowPrices.length - 1], // Range
        closePrices[closePrices.length - 1] - closePrices[closePrices.length - 2] || 0, // Price Change
        volumes[volumes.length - 1] / (volumes[volumes.length - 2] || 1) // Volume Ratio
    ];
}

// Hàm huấn luyện mô hình ban đầu
async function trainModelData(data) {
    try {
        const inputs = [];
        const outputs = [];
        for (let i = currentConfig.windowSize; i < data.length; i++) {
            const windowFeatures = [];
            for (let j = i - currentConfig.windowSize; j < i; j++) {
                windowFeatures.push(computeFeature(data, j));
            }
            inputs.push(windowFeatures);

            const subData = data.slice(0, i + 1);
            const currentPrice = subData[subData.length - 1].close;
            const futureData = data.slice(i + 1, i + 11);
            let trueSignal = [0, 0, 1]; // HOLD
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
        await model.fit(xs, ys, { epochs: currentConfig.epochs, batchSize: 16, shuffle: true });
        await saveModel(model); // Lưu thủ công
        console.log('✅ Mô hình đã được huấn luyện ban đầu.');
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Mô hình đã được huấn luyện\n`);
        xs.dispose();
        ys.dispose();
    } catch (error) {
        console.error('Lỗi huấn luyện mô hình:', error.message);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi huấn luyện: ${error.message}\n`);
    }
}

// Hàm tối ưu hóa mô hình
async function optimizeModel() {
    if (recentAccuracies.length < 50) return;

    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    if (avgAcc > 0.7) return;

    console.log('⚙️ Bắt đầu tối ưu hóa mô hình...');
    fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Bắt đầu tối ưu hóa mô hình\n`);

    const configsToTest = [
        { windowSize: 5, units: 32, epochs: 10 },
        { windowSize: 10, units: 64, epochs: 15 },
        { windowSize: 15, units: 128, epochs: 20 }
    ];

    for (const config of configsToTest) {
        console.log(`Thử cấu hình: ${JSON.stringify(config)}`);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Thử cấu hình: ${JSON.stringify(config)}\n`);

        currentConfig = { ...config };
        model = createModel(config.windowSize, config.units);

        const initialData = await fetchKlines('BTC', 'USDT', '1h', 200);
        if (!initialData) {
            console.error('❌ Không thể lấy dữ liệu để tối ưu hóa mô hình');
            continue;
        }
        await trainModelData(initialData);

        recentAccuracies = [];
        const historicalData = await fetchKlines('BTC', 'USDT', '1h', 200);
        if (historicalData) {
            for (let i = currentConfig.windowSize; i < Math.min(historicalData.length, 50 + currentConfig.windowSize); i++) {
                await selfEvaluateAndTrain(historicalData.slice(0, i), i, historicalData);
            }
        }

        const newAvgAcc = recentAccuracies.length > 0 ? recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length : 0;
        console.log(`Độ chính xác trung bình với cấu hình ${JSON.stringify(config)}: ${(newAvgAcc * 100).toFixed(2)}%`);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Độ chính xác: ${(newAvgAcc * 100).toFixed(2)}%\n`);

        if (newAvgAcc > bestAccuracy) {
            bestAccuracy = newAvgAcc;
            bestConfig = { ...config };
        }
    }

    currentConfig = { ...bestConfig };
    model = createModel(bestConfig.windowSize, bestConfig.units);
    await saveModel(model); // Lưu mô hình thủ công
    console.log(`✅ Đã áp dụng cấu hình tốt nhất: ${JSON.stringify(bestConfig)} với độ chính xác: ${(bestAccuracy * 100).toFixed(2)}%`);
    fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Cấu hình tốt nhất: ${JSON.stringify(bestConfig)}\n`);

    if (adminChatId) {
        bot.sendMessage(adminChatId, `✅ *Tối ưu hóa mô hình hoàn tất*\nCấu hình tốt nhất: ${JSON.stringify(bestConfig)}\nĐộ chính xác: ${(bestAccuracy * 100).toFixed(2)}\\%`, { parse_mode: 'Markdown' });
    }

    await trainModelWithMultiplePairs();
}

// Hàm tự đánh giá và huấn luyện
async function selfEvaluateAndTrain(historicalSlice, currentIndex, fullData) {
    const windowFeatures = [];
    for (let j = currentIndex - currentConfig.windowSize; j < currentIndex; j++) {
        windowFeatures.push(computeFeature(historicalSlice, j));
    }
    const input = tf.tensor3d([windowFeatures]);
    const prediction = model.predict(input);
    const predictedSignal = prediction.argMax(-1).dataSync()[0];
    const confidence = prediction.max().dataSync()[0];

    const futureData = fullData.slice(currentIndex + 1, currentIndex + 11);
    let trueSignal = [0, 0, 1]; // HOLD
    if (futureData.length >= 10) {
        const currentPrice = historicalSlice[historicalSlice.length - 1].close;
        const futurePrice = futureData[futureData.length - 1].close;
        const priceChange = (futurePrice - currentPrice) / currentPrice * 100;
        if (priceChange > 0.5) trueSignal = [1, 0, 0]; // LONG
        else if (priceChange < -0.5) trueSignal = [0, 1, 0]; // SHORT
    }

    const correct = predictedSignal === trueSignal.indexOf(1);
    recentAccuracies.push(correct ? 1 : 0);
    if (recentAccuracies.length > 50) recentAccuracies.shift();

    const xs = tf.tensor3d([windowFeatures]);
    const ys = tf.tensor2d([trueSignal]);
    await model.fit(xs, ys, { epochs: 1, batchSize: 1 });
    await saveModel(model); // Lưu thủ công sau mỗi lần huấn luyện

    input.dispose();
    prediction.dispose();
    xs.dispose();
    ys.dispose();
}

// Hàm lấy dữ liệu klines
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
            if (filteredKlines.length < limit / 2) {
                throw new Error(`Dữ liệu hợp lệ quá ít (${filteredKlines.length}/${limit})`);
            }
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

// Hàm huấn luyện với nhiều cặp
async function trainModelWithMultiplePairs() {
    const pairs = [
        { symbol: 'BTC', pair: 'USDT', timeframe: '1h' },
        { symbol: 'ADA', pair: 'USDT', timeframe: '1h' },
    ];

    for (const { symbol, pair, timeframe } of pairs) {
        const data = await fetchKlines(symbol, pair, timeframe, 500);
        if (data) {
            console.log(`Huấn luyện với ${symbol}/${pair} (${timeframe})...`);
            await trainModelData(data);
        } else {
            console.error(`Không thể lấy dữ liệu ${symbol}/${pair} để huấn luyện.`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Hàm khởi tạo mô hình
async function initializeModel() {
    try {
        model = await loadModel();
        console.log('✅ Đã tải mô hình từ file thủ công.');
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Đã tải mô hình từ ${MODEL_DIR}\n`);
    } catch (error) {
        console.error('Lỗi khởi tạo mô hình:', error.message);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi khởi tạo mô hình: ${error.message}\n`);
        model = createModel(currentConfig.windowSize, currentConfig.units);
    }
}

// Hàm chính để khởi động bot
(async () => {
    await initializeModel();
    await trainModelWithMultiplePairs();
    console.log('✅ Bot đã khởi động và sẵn sàng nhận lệnh.');
    fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Bot đã khởi động\n`);
})();