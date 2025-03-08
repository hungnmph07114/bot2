const sqlite3 = require('sqlite3').verbose();
const tf = require('@tensorflow/tfjs');
const ccxt = require('ccxt');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// Cấu hình cơ bản
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7644381153:AAGtd8uhtdPFbDqlpA9NAUSsIsePXQiO36g';
const bot = new TelegramBot(TOKEN, { polling: true });
const binance = new ccxt.binance({ enableRateLimit: true });
let adminChatId = null;
let model = null;
let currentConfig = { windowSize: 10, units: 64, epochs: 15 };
let bestConfig = { ...currentConfig };
let bestAccuracy = 0;
let recentAccuracies = [];
let lastAccuracy = 0;
let trainingCounter = 0;
let trainingLimit = 1000;
let shouldStopTraining = false;
let enableSimulation = true;

// Khởi tạo SQLite
const db = new sqlite3.Database('/bot.db', (err) => {
    if (err) {
        console.error('SQLite Error:', err.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi kết nối SQLite: ${err.message}\n`);
    } else {
        console.log('✅ Kết nối SQLite thành công.');
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - ✅ Kết nối SQLite thành công.\n`);
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS watch_configs (
    chatId TEXT,
    symbol TEXT,
    pair TEXT,
    timeframe TEXT,
    showTechnicalIndicators BOOLEAN DEFAULT 0,
    PRIMARY KEY (chatId, symbol, pair, timeframe)
  )`, (err) => {
        if (err) {
            console.error('Lỗi tạo bảng watch_configs:', err.message);
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi tạo bảng watch_configs: ${err.message}\n`);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS signal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId TEXT,
    symbol TEXT,
    pair TEXT,
    timeframe TEXT,
    signalText TEXT,
    entryPrice REAL,
    stopLoss REAL,
    takeProfit REAL,
    timestamp INTEGER,
    profit REAL
  )`, (err) => {
        if (err) {
            console.error('Lỗi tạo bảng signal_history:', err.message);
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi tạo bảng signal_history: ${err.message}\n`);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS user_settings (
    chatId TEXT PRIMARY KEY,
    showTechnicalIndicators BOOLEAN DEFAULT 0
  )`, (err) => {
        if (err) {
            console.error('Lỗi tạo bảng user_settings:', err.message);
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi tạo bảng user_settings: ${err.message}\n`);
        }
    });
});

// Tạo mô hình LSTM
function createModel(windowSize, units) {
    const model = tf.sequential();
    model.add(tf.layers.lstm({
        units: units,
        inputShape: [windowSize, 11], // 11 đặc trưng: RSI, MACD, v.v.
        returnSequences: false
    }));
    model.add(tf.layers.dense({ units: 3, activation: 'softmax' })); // 3 lớp đầu ra: LONG, SHORT, WAIT
    model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy']
    });
    return model;
}

// Khởi tạo mô hình
async function initializeModel() {
    const modelPath = '/model.json';
    try {
        if (fs.existsSync(modelPath)) {
            model = await tf.loadLayersModel(`file://${modelPath}`);
            console.log('✅ Đã tải mô hình từ file trong thư mục chính.');
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Đã tải mô hình từ file.\n`);
        } else {
            model = createModel(currentConfig.windowSize, currentConfig.units);
            console.log('⚠️ Không tìm thấy mô hình, tạo mô hình mới.');
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Không tìm thấy mô hình, tạo mới.\n`);
            const initialData = await fetchKlines('BTC', 'USDT', '1h', 50);
            if (initialData && initialData.length > 0) {
                await trainModelData(initialData);
            } else {
                console.log('⚠️ Không thể lấy dữ liệu để huấn luyện ban đầu.');
                fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Không thể lấy dữ liệu để huấn luyện ban đầu.\n`);
            }
            await saveModel();
        }
    } catch (error) {
        console.error('Lỗi khởi tạo mô hình:', error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi khởi tạo mô hình: ${error.message}\n`);
    }
}

// Lưu mô hình
async function saveModel() {
    try {
        await model.save('file:///model');
        console.log('✅ Mô hình đã được lưu trong thư mục chính.');
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Mô hình đã được lưu tại /model.\n`);
    } catch (error) {
        console.error('Lỗi lưu mô hình:', error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi lưu mô hình: ${error.message}\n`);
    }
}

// Huấn luyện mô hình với dữ liệu ban đầu
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
            let trueSignal = [0, 0, 1]; // WAIT
            if (futureData.length >= 10) {
                const futurePrice = futureData[futureData.length - 1].close;
                const priceChange = (futurePrice - currentPrice) / currentPrice * 100;
                if (priceChange > 0.5) trueSignal = [1, 0, 0]; // LONG
                else if (priceChange < -0.5) trueSignal = [0, 1, 0]; // SHORT
            }
            outputs.push(trueSignal);
        }
        if (inputs.length === 0) {
            console.log('⚠️ Không đủ dữ liệu để huấn luyện.');
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Không đủ dữ liệu để huấn luyện.\n`);
            return;
        }
        const xs = tf.tensor3d(inputs);
        const ys = tf.tensor2d(outputs);
        await model.fit(xs, ys, { epochs: currentConfig.epochs, batchSize: 16, shuffle: true });
        await saveModel();
        console.log('✅ Mô hình đã được huấn luyện ban đầu và lưu.');
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Mô hình đã được huấn luyện ban đầu và lưu.\n`);
        xs.dispose();
        ys.dispose();
    } catch (error) {
        console.error('Lỗi huấn luyện mô hình:', error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi huấn luyện: ${error.message}\n`);
    }
}

// Huấn luyện với nhiều cặp tiền
async function trainModelWithMultiplePairs() {
    const pairs = [
        { symbol: 'BTC', pair: 'USDT', timeframe: '1h' },
        { symbol: 'ADA', pair: 'USDT', timeframe: '1h' },
        { symbol: 'ETH', pair: 'USDT', timeframe: '1h' }
    ];

    for (const { symbol, pair, timeframe } of pairs) {
        const data = await fetchKlines(symbol, pair, timeframe, 50);
        if (data && data.length > 0) {
            console.log(`Huấn luyện với ${symbol}/${pair} (${timeframe})...`);
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Bắt đầu huấn luyện với ${symbol}/${pair} (${timeframe}).\n`);
            await trainModelData(data);
        } else {
            console.error(`Không thể lấy dữ liệu ${symbol}/${pair} để huấn luyện.`);
            fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Không thể lấy dữ liệu ${symbol}/${pair} để huấn luyện.\n`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Throttling
    }
}

// Tinh chỉnh mô hình (Incremental Learning)
async function selfEvaluateAndTrain(historicalSlice, currentIndex, fullData) {
    if (!historicalSlice || !fullData || shouldStopTraining || trainingCounter >= trainingLimit) return;

    const currentVolume = historicalSlice[historicalSlice.length - 1].volume || 0;
    const volumeMA = computeMA(historicalSlice.map(d => d.volume || 0), 20) || 0;
    const atr = computeATR(historicalSlice) || 0;
    const priceChange = historicalSlice.length >= 2
        ? (historicalSlice[historicalSlice.length - 1].close - historicalSlice[historicalSlice.length - 2].close) / historicalSlice[historicalSlice.length - 2].close * 100
        : 0;

    if (currentVolume <= volumeMA * 1.5 && Math.abs(priceChange) < atr * 2) {
        console.log(`Bỏ qua huấn luyện tại nến ${currentIndex} vì không có biến động đáng kể.`);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Bỏ qua huấn luyện tại nến ${currentIndex} (volume: ${currentVolume}, priceChange: ${priceChange.toFixed(2)}%)\n`);
        return;
    }

    trainingCounter++;
    const windowFeatures = [];
    for (let i = historicalSlice.length - currentConfig.windowSize; i < historicalSlice.length; i++) {
        if (i >= 0) windowFeatures.push(computeFeature(historicalSlice, i));
    }

    if (windowFeatures.length !== currentConfig.windowSize) {
        console.log(`⚠️ Dữ liệu không đủ tại nến ${currentIndex}, bỏ qua.`);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Dữ liệu không đủ tại nến ${currentIndex}, bỏ qua.\n`);
        return;
    }

    const trueSignal = computeTrueSignal(historicalSlice, fullData, currentIndex);
    const xs = tf.tensor3d([windowFeatures]);
    const ys = tf.tensor2d([trueSignal]);

    try {
        model.compile({ optimizer: tf.train.adam(0.0001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
        const history = await model.fit(xs, ys, { epochs: 1, batchSize: 1 });
        await saveModel();

        xs.dispose();
        ys.dispose();
        const loss = history.history.loss[0];
        lastAccuracy = 1.0 - loss;
        recentAccuracies.push(lastAccuracy);
        if (recentAccuracies.length > 50) recentAccuracies.shift();

        console.log(`✅ Tinh chỉnh tại nến ${currentIndex} | Loss: ${loss.toFixed(4)} | Accuracy: ${(lastAccuracy * 100).toFixed(2)}%`);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Tinh chỉnh tại nến ${currentIndex} | Loss: ${loss.toFixed(4)}\n`);
    } catch (error) {
        console.error(`Lỗi tinh chỉnh tại nến ${currentIndex}:`, error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi tinh chỉnh tại nến ${currentIndex}: ${error.message}\n`);
    }
}

// Tối ưu hóa mô hình
async function optimizeModel() {
    if (recentAccuracies.length < 50) return;

    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    if (avgAcc > 0.7) return;

    console.log('⚙️ Bắt đầu tối ưu hóa mô hình...');
    fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Bắt đầu tối ưu hóa mô hình...\n`);

    const configsToTest = [
        { windowSize: 5, units: 32, epochs: 10 },
        { windowSize: 10, units: 64, epochs: 15 },
        { windowSize: 15, units: 128, epochs: 20 }
    ];

    for (const config of configsToTest) {
        currentConfig = { ...config };
        model = createModel(config.windowSize, config.units);
        const initialData = await fetchKlines('BTC', 'USDT', '1h', 50);
        if (!initialData || initialData.length === 0) continue;

        await trainModelData(initialData);
        await saveModel();
    }

    console.log(`✅ Đã áp dụng cấu hình tốt nhất: ${JSON.stringify(bestConfig)}`);
    fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Đã áp dụng cấu hình tốt nhất: ${JSON.stringify(bestConfig)}\n`);
}

// Hàm tính tín hiệu thật
function computeTrueSignal(historicalSlice, fullData, currentIndex) {
    if (!historicalSlice || historicalSlice.length === 0) return [0, 0, 1]; // WAIT
    const currentPrice = historicalSlice[historicalSlice.length - 1].close;
    const futureData = fullData.slice(currentIndex + 1, currentIndex + 11);
    if (futureData.length < 10) return [0, 0, 1]; // WAIT
    const futurePrice = futureData[futureData.length - 1].close;
    const priceChange = (futurePrice - currentPrice) / currentPrice * 100;
    if (priceChange > 1.5) return [1, 0, 0]; // LONG
    if (priceChange < -1.5) return [0, 1, 0]; // SHORT
    return [0, 0, 1]; // WAIT
}

// Hàm lấy dữ liệu từ Binance
async function fetchKlines(symbol, pair, timeframe, limit) {
    try {
        const klines = await binance.fetchOHLCV(`${symbol}/${pair}`, timeframe, undefined, limit);
        return klines.map(([timestamp, open, high, low, close, volume]) => ({
            timestamp, open, high, low, close, volume
        }));
    } catch (error) {
        console.error(`Lỗi lấy dữ liệu ${symbol}/${pair}:`, error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi lấy dữ liệu ${symbol}/${pair}: ${error.message}\n`);
        return [];
    }
}

// Hàm tính Moving Average
function computeMA(data, period) {
    if (data.length < period) return 0;
    const sum = data.slice(-period).reduce((acc, val) => acc + val, 0);
    return sum / period;
}

// Hàm tính ATR (Average True Range)
function computeATR(data) {
    if (data.length < 14) return 0;
    const trueRanges = [];
    for (let i = 1; i < data.length; i++) {
        const high = data[i].high;
        const low = data[i].low;
        const prevClose = data[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trueRanges.push(tr);
    }
    if (trueRanges.length < 14) return 0;
    return computeMA(trueRanges, 14);
}

// Hàm tính đặc trưng (Feature)
function computeFeature(data, index) {
    if (index < 0 || index >= data.length) return Array(11).fill(0);
    const candle = data[index];
    const prevCandle = index > 0 ? data[index - 1] : candle;
    const rsi = calculateRSI(data, index, 14); // Hàm RSI giả định
    const macd = calculateMACD(data, index); // Hàm MACD giả định
    const bb = calculateBollingerBands(data, index); // Hàm Bollinger Bands giả định
    return [
        candle.close, candle.high, candle.low, candle.volume,
        rsi, macd.macd, macd.signal, macd.histogram,
        bb.upper, bb.middle, bb.lower
    ].map(v => isNaN(v) ? 0 : v);
}

// Hàm tính RSI (giả định)
function calculateRSI(data, index, period) {
    if (index < period || data.length < period) return 50;
    let gains = 0, losses = 0;
    for (let i = index - period + 1; i <= index; i++) {
        const diff = data[i].close - (data[i - 1] ? data[i - 1].close : data[i].close);
        gains += diff > 0 ? diff : 0;
        losses += diff < 0 ? -diff : 0;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period || 1e-10;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Hàm tính MACD (giả định)
function calculateMACD(data, index) {
    if (data.length < index + 1) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = calculateEMA(data, index, 12);
    const ema26 = calculateEMA(data, index, 26);
    const macd = ema12 - ema26;
    const signal = calculateEMA(data.map(d => macd), index, 9); // Giả định
    return { macd, signal, histogram: macd - signal };
}

// Hàm tính EMA (giả định)
function calculateEMA(data, index, period) {
    if (index < period - 1) return data[index].close;
    let ema = data[index - period + 1].close;
    const multiplier = 2 / (period + 1);
    for (let i = index - period + 2; i <= index; i++) {
        ema = (data[i].close - ema) * multiplier + ema;
    }
    return ema;
}

// Hàm tính Bollinger Bands (giả định)
function calculateBollingerBands(data, index) {
    if (data.length < index + 1) return { upper: 0, middle: 0, lower: 0 };
    const period = 20;
    if (index < period - 1) return { upper: data[index].close, middle: data[index].close, lower: data[index].close };
    const prices = data.slice(index - period + 1, index + 1).map(d => d.close);
    const ma = computeMA(prices, period);
    const stdDev = Math.sqrt(computeVariance(prices, ma));
    return {
        upper: ma + 2 * stdDev,
        middle: ma,
        lower: ma - 2 * stdDev
    };
}

function computeVariance(data, mean) {
    const squareDiffs = data.map(value => {
        const diff = value - mean;
        return diff * diff;
    });
    const avgSquareDiff = computeMA(squareDiffs, data.length);
    return avgSquareDiff || 0;
}

// Hàm giả lập giao dịch
async function simulateTrade(symbol, pair, timeframe, signalText, entryPrice, sl, tp, entryTime) {
    try {
        const klines = await fetchKlines(symbol, pair, timeframe, 50);
        if (klines.length === 0) return { profit: null };
        const exitPrice = klines[klines.length - 1].close;
        let profit = 0;
        if (signalText === 'LONG' && exitPrice >= tp) profit = (tp - entryPrice) / entryPrice * 100;
        else if (signalText === 'LONG' && exitPrice <= sl) profit = (sl - entryPrice) / entryPrice * 100;
        else if (signalText === 'SHORT' && exitPrice <= tp) profit = (entryPrice - tp) / entryPrice * 100;
        else if (signalText === 'SHORT' && exitPrice >= sl) profit = (entryPrice - sl) / entryPrice * 100;
        return { profit: profit || 0 };
    } catch (error) {
        console.error('Lỗi giả lập giao dịch:', error.message);
        fs.appendFileSync('/bot.log', `${new Date().toISOString()} - Lỗi giả lập giao dịch: ${error.message}\n`);
        return { profit: null };
    }
}

// Lệnh Telegram: /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const memoryUsage = process.memoryUsage().rss / 1024 / 1024;
    const avgAcc = recentAccuracies.length > 0
        ? (recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length * 100).toFixed(2)
        : 0;
    const message = `📊 Trạng thái bot:\n` +
        `🔹 Độ chính xác trung bình: ${avgAcc}%\n` +
        `🔹 RAM: ${memoryUsage.toFixed(2)} MB\n` +
        `🔹 Số lần huấn luyện: ${trainingCounter}\n` +
        `🔹 Cấu hình hiện tại: ${JSON.stringify(currentConfig)}`;
    bot.sendMessage(chatId, message);
});

// Lệnh Telegram: /tinhieu
bot.onText(/\/tinhieu/, async (msg) => {
    const chatId = msg.chat.id;
    const args = msg.text.split(' ').slice(1);
    const [symbol, pair, timeframe] = args.length >= 3 ? args : ['BTC', 'USDT', '1h'];
    const klines = await fetchKlines(symbol, pair, timeframe, 50);
    if (klines.length === 0) {
        bot.sendMessage(chatId, `❌ Không thể lấy dữ liệu ${symbol}/${pair} (${timeframe}).`);
        return;
    }
    const { signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);
    bot.sendMessage(chatId, `📈 Tín hiệu ${symbol}/${pair} (${timeframe}):\n${signalText}\nEntry: ${entryPrice}\nSL: ${sl}\nTP: ${tp}`);
});

// Hàm phân tích crypto (giả định từ mã gốc)
async function getCryptoAnalysis(symbol, pair, timeframe, chatId) {
    const klines = await fetchKlines(symbol, pair, timeframe, 50);
    if (klines.length < currentConfig.windowSize) return { signalText: 'WAIT', entryPrice: 0, sl: 0, tp: 0 };

    const windowFeatures = [];
    for (let i = klines.length - currentConfig.windowSize; i < klines.length; i++) {
        windowFeatures.push(computeFeature(klines, i));
    }
    const xs = tf.tensor3d([windowFeatures]);
    const prediction = model.predict(xs);
    const signal = prediction.argMax(-1).dataSync()[0];
    xs.dispose();

    const currentPrice = klines[klines.length - 1].close;
    const atr = computeATR(klines);
    let signalText = ['LONG', 'SHORT', 'WAIT'][signal];
    let entryPrice = currentPrice;
    let sl = signalText === 'LONG' ? currentPrice - 2 * atr : currentPrice + 2 * atr;
    let tp = signalText === 'LONG' ? currentPrice + 4 * atr : currentPrice - 4 * atr;

    if (enableSimulation) {
        const { profit } = await simulateTrade(symbol, pair, timeframe, signalText, entryPrice, sl, tp, Date.now());
        if (profit !== null) {
            db.run(`INSERT INTO signal_history (chatId, symbol, pair, timeframe, signalText, entryPrice, stopLoss, takeProfit, timestamp, profit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [chatId, symbol, pair, timeframe, signalText, entryPrice, sl, tp, Date.now(), profit]);
        }
    }

    return { signalText, entryPrice, sl, tp };
}

// Khởi động bot
(async () => {
    bot.on('message', (msg) => {
        if (!adminChatId) adminChatId = msg.chat.id;
    });

    await initializeModel();
    console.log('✅ Bot đã khởi động thành công.');
    fs.appendFileSync('/bot.log', `${new Date().toISOString()} - ✅ Bot đã khởi động thành công.\n`);

    // Chạy vòng lặp theo dõi
    setInterval(async () => {
        const watchedPairs = await new Promise((resolve, reject) => {
            db.all('SELECT symbol, pair, timeframe FROM watch_configs WHERE chatId = ?', [adminChatId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        for (const { symbol, pair, timeframe } of watchedPairs) {
            const klines = await fetchKlines(symbol, pair, timeframe, 50);
            if (klines.length > 0) {
                await selfEvaluateAndTrain(klines, klines.length - 1, klines);
                const { signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, adminChatId);
                if (signalText !== 'WAIT') {
                    bot.sendMessage(adminChatId, `📡 Tín hiệu mới ${symbol}/${pair} (${timeframe}):\n${signalText}\nEntry: ${entryPrice}\nSL: ${sl}\nTP: ${tp}`);
                }
            }
        }
    }, 60000); // Chạy mỗi phút
})();