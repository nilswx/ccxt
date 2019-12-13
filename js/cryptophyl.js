'use strict';

//  ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError, ArgumentsRequired, InsufficientFunds, OrderNotFound, InvalidOrder, AuthenticationError } = require ('./base/errors');

//  ---------------------------------------------------------------------------

module.exports = class cryptophyl extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'cryptophyl',
            'name': 'Cryptophyl',
            'version': 'v3',
            'countries': [ 'UK' ],
            'rateLimit': 1000,
            'has': {
                'fetchMarkets': true,
                'fetchTicker': true,
                'fetchTrades': true,
                'fetchOHLCV': true,
                'fetchOrder': true,
                'fetchOpenOrders': true,
                'fetchMyTrades': true,
                'withdraw': true,
            },
            'timeframes': {
                '1m': '60',
                '5m': '300',
                '15m': '900',
                '1h': '3600',
                '6h': '21600',
                '1d': '86400',
            },
            'urls': {
                'logo': 'https://user-images.githubusercontent.com/1294454/38046312-0b450aac-32c8-11e8-99ab-bc6b136b6cc7.jpg',
                'api': 'https://api.cryptophyl.com',
                'www': 'https://cryptophyl.com',
                'doc': 'https://docs.cryptophyl.com',
                'fees': 'https://cryptophyl.com/fees',
                'referral': 'https://cryptophyl.com?r=V9PdTtH12Yk',
            },
            'api': {
                'public': {
                    'get': [
                        'products',
                        'products/{id}/book',
                        'products/{id}/candles',
                        'products/{id}/trades',
                        'products/{id}/ticker',
                        'products/{id}/stats',
                    ],
                },
                'private': {
                    'get': [
                        'users/self',
                        'orders',
                        'orders/{id}',
                        'fills',
                    ],
                    'post': [
                        'orders',
                        'withdrawals',
                    ],
                    'delete': [
                        'orders/{id}',
                    ],
                },
            },
            'fees': {
                'trading': {
                    'percentage': true,
                    'maker': 0.15 / 100,
                    'taker': 0.15 / 100,
                },
            },
            'precision': {
                'amount': 8,
                'price': 8,
            },
        });
    }

    async fetchMarkets (params = {}) {
        const markets = await this.publicGetProducts (params);
        // {
        //     "id": "SAI-BCH",
        //     "primary_currency": "SAI",
        //     "secondary_currency": "BCH",
        //     "maker_fee_rate": "0.0015",
        //     "taker_fee_rate": "0.0015",
        //     "price_increment": "0.00000001",
        //     "quantity_increment": "0.00000001"
        // }
        //
        const result = [];
        for (let i = 0; i < markets.length; i++) {
            const market = markets[i];
            const baseId = this.safeString (market, 'primary_currency');
            const quoteId = this.safeString (market, 'secondary_currency');
            const base = this.safeCurrencyCode (baseId);
            const quote = this.safeCurrencyCode (quoteId);
            const precision = {
                'amount': this.safeInteger (market, 'trading_decimal'),
                'price': this.safeInteger (market, 'pricing_decimal'),
            };
            result.push ({
                'id': this.safeString (market, 'id'),
                'symbol': base + '/' + quote,
                'base': base,
                'quote': quote,
                'baseId': baseId,
                'quoteId': quoteId,
                'active': true,
                'taker': this.safeFloat (market, 'taker_fee_rate'),
                'maker': this.safeFloat (market, 'maker_fee_rate'),
                'info': market,
                'precision': precision,
                'limits': {
                    'amount': {
                        'min': this.safeFloat (market, 'min_amount'),
                        'max': undefined,
                    },
                    'price': {
                        'min': Math.pow (10, -precision['price']),
                        'max': undefined,
                    },
                },
            });
        }
        return result;
    }

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        await this.loadMarkets ();
        const request = {
            'id': this.marketId (symbol),
        };
        const response = await this.publicGetProductsIdBook (this.extend (request, params));
        return this.parseOrderBook (response['data']);
    }

    async fetchOHLCV (symbol, timeframe = '5m', since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'id': market['id'],
            'granularity': this.timeframes[timeframe],
        };
        const response = await this.publicGetProductsIdCandles (this.extend (request, params));
        return this.parseOHLCVs (response, market, timeframe, since, limit);
    }

    parseOHLCV (ohlcv, market = undefined, timeframe = '5m', since = undefined, limit = undefined) {
        return [
            ohlcv[0] * 1000,
            parseFloat (ohlcv[1]),
            parseFloat (ohlcv[3]),
            parseFloat (ohlcv[4]),
            parseFloat (ohlcv[2]),
            parseFloat (ohlcv[5]),
        ];
    }

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'id': market['id'],
        };
        const response = await this.publicGetProductsIdTrades (this.extend (request, params));
        return this.parseTrades (response['data'], market, since, limit);
    }

    parseTrade (trade, market = undefined) {
        // this method parses both public and private trades
        let timestamp = this.safeTimestamp (trade, 'create_time');
        if (timestamp === undefined) {
            timestamp = this.safeInteger (trade, 'date_ms');
        }
        const tradeId = this.safeString (trade, 'id');
        const orderId = this.safeString (trade, 'order_id');
        const price = this.safeFloat (trade, 'price');
        const amount = this.safeFloat (trade, 'amount');
        const marketId = this.safeString (trade, 'market');
        market = this.safeValue (this.markets_by_id, marketId, market);
        let symbol = undefined;
        if (market !== undefined) {
            symbol = market['symbol'];
        }
        let cost = this.safeFloat (trade, 'deal_money');
        if (!cost) {
            cost = parseFloat (this.costToPrecision (symbol, price * amount));
        }
        let fee = undefined;
        const feeCost = this.safeFloat (trade, 'fee');
        if (feeCost !== undefined) {
            const feeCurrencyId = this.safeString (trade, 'fee_asset');
            const feeCurrencyCode = this.safeCurrencyCode (feeCurrencyId);
            fee = {
                'cost': feeCost,
                'currency': feeCurrencyCode,
            };
        }
        const takerOrMaker = this.safeString (trade, 'role');
        const side = this.safeString (trade, 'type');
        return {
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'id': tradeId,
            'order': orderId,
            'type': undefined,
            'side': side,
            'takerOrMaker': takerOrMaker,
            'price': price,
            'amount': amount,
            'cost': cost,
            'fee': fee,
        };
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'id': market['id'],
        };
        const response = await this.publicGetProductsIdTicker (this.extend (request, params));
        return this.parseTicker (response['data'], market);
    }

    parseTicker (ticker, market = undefined) {
        const timestamp = this.safeInteger (ticker, 'date');
        let symbol = undefined;
        if (market !== undefined) {
            symbol = market['symbol'];
        }
        ticker = this.safeValue (ticker, 'ticker', {});
        const last = this.safeFloat (ticker, 'last');
        return {
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'high': this.safeFloat (ticker, 'high'),
            'low': this.safeFloat (ticker, 'low'),
            'bid': this.safeFloat (ticker, 'buy'),
            'bidVolume': undefined,
            'ask': this.safeFloat (ticker, 'sell'),
            'askVolume': undefined,
            'vwap': undefined,
            'open': undefined,
            'close': last,
            'last': last,
            'previousClose': undefined,
            'change': undefined,
            'percentage': undefined,
            'average': undefined,
            'baseVolume': this.safeFloat2 (ticker, 'vol', 'volume'),
            'quoteVolume': undefined,
            'info': ticker,
        };
    }

    async fetchBalance (params = {}) {
        await this.loadMarkets ();
        const response = await this.privateGetSelf (params);
        // {
        //     "id": "1",
        //     "name": "Lillian Kuvalis",
        //     "email": "terrill14@cveiguulymquns4m.ga",
        //     "balances": {
        //     "BCH": "100",
        //         "SPICE": "100",
        //         "USDH": "0",
        //         "DROP": "0",
        //         "TOBA": "0",
        //         "SAI": "0"
        //      },
        //     "locked_balances": {
        //         "BCH": "0",
        //         "SPICE": "0",
        //         "USDH": "0",
        //         "DROP": "0",
        //         "TOBA": "0",
        //         "SAI": "0"
        //      }
        // }
        const balances = this.safeValue (response, 'balances');
        const result = { 'info': balances };
        const currencyIds = Object.keys (balances);
        for (let i = 0; i < currencyIds.length; i++) {
            const currencyId = currencyIds[i];
            const code = this.safeCurrencyCode (currencyId);
            const balance = this.safeValue (balances, currencyId, {});
            const account = this.account ();
            account['free'] = this.safeFloat (balance, 'available');
            account['used'] = this.safeFloat (balance, 'frozen');
            result[code] = account;
        }
        return this.parseBalance (result);
    }

    async withdraw (code, amount, address, tag = undefined, params = {}) {
        this.checkAddress (address);
        await this.loadMarkets ();
        const currency = this.currency (code);
        if (tag) {
            address = address + ':' + tag;
        }
        const request = {
            'coin_type': currency['id'],
            'coin_address': address, // must be authorized, inter-user transfer by a registered mobile phone number or an email address is supported
            'actual_amount': parseFloat (amount), // the actual amount without fees, https://www.coinex.com/fees
            'transfer_method': '1', // '1' = normal onchain transfer, '2' = internal local transfer from one user to another
        };
        const response = await this.privatePostWithdrawals (this.extend (request, params));
        // {
        //     "id": "1",
        //     "address": "bitcoincash:qzjpvz5lzskpepz56xrg36xupm707symsqt0jj7aat",
        //     "amount": "0.1",
        //     "currency": "BCH",
        //     "time": "2018-08-11T13:31:30.000Z",
        //     "transaction_id": "8c8816bfc5abab335455bc5db507b4a28a2d722ce1f37a350530c2d8bb7a9b5b"
        // }
        const transaction = this.safeValue (response, 'data', {});
        return this.parseTransaction (transaction, currency);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'market': market['id'],
            'type': type,
            'side': side,
        };
        amount = parseFloat (amount);
        // for market buy it requires the amount of quote currency to spend
        if ((type === 'market') && (side === 'buy')) {
            if (this.options['createMarketBuyOrderRequiresPrice']) {
                if (price === undefined) {
                    throw new InvalidOrder (this.id + " createOrder() requires the price argument with market buy orders to calculate total order cost (amount to spend), where cost = amount * price. Supply a price argument to createOrder() call if you want the cost to be calculated for you from price and amount, or, alternatively, add .options['createMarketBuyOrderRequiresPrice'] = false to supply the cost in the amount argument (the exchange-specific behaviour)");
                } else {
                    price = parseFloat (price);
                    request['amount'] = this.costToPrecision (symbol, amount * price);
                }
            } else {
                request['amount'] = this.costToPrecision (symbol, amount);
            }
        } else {
            request['amount'] = this.amountToPrecision (symbol, amount);
        }
        if ((type === 'limit') || (type === 'ioc')) {
            request['price'] = this.priceToPrecision (symbol, price);
        }
        const response = await this.privatePostOrders (this.extend (request, params));
        const order = this.parseOrder (response['data'], market);
        const id = order['id'];
        this.orders[id] = order;
        return order;
    }

    parseOrder (order, market = undefined) {
        //
        // fetchOrder
        //
        //     {
        //         "amount": "0.1",
        //         "asset_fee": "0.22736197736197736197",
        //         "avg_price": "196.85000000000000000000",
        //         "create_time": 1537270135,
        //         "deal_amount": "0.1",
        //         "deal_fee": "0",
        //         "deal_money": "19.685",
        //         "fee_asset": "CET",
        //         "fee_discount": "0.5",
        //         "id": 1788259447,
        //         "left": "0",
        //         "maker_fee_rate": "0",
        //         "market": "ETHUSDT",
        //         "order_type": "limit",
        //         "price": "170.00000000",
        //         "status": "done",
        //         "taker_fee_rate": "0.0005",
        //         "type": "sell",
        //     }
        //

        //
        // {
        //     "id": "0000000000000001",
        //     "type": "limit",
        //     "side": "buy",
        //     "product_id": "SPICE-BCH",
        //     "price": "4.0338",
        //     "quantity": "0.00184",
        //     "remaining_quantity": "0.00184",
        //     "time": "2018-05-30T14:29:27.891Z"
        // }
        //

        const timestamp = this.safeTimestamp (order, 'time');
        const price = this.safeFloat (order, 'price');
        const cost = this.safeFloat (order, 'deal_money');
        const amount = this.safeFloat (order, 'quantity');
        const filled = this.safeFloat (order, 'deal_amount');
        const average = this.safeFloat (order, 'avg_price');
        let symbol = undefined;
        const marketId = this.safeString (order, 'product_id');
        market = this.safeValue (this.markets_by_id, marketId);
        const feeCurrencyId = this.safeString (order, 'fee_asset');
        let feeCurrency = this.safeCurrencyCode (feeCurrencyId);
        if (market !== undefined) {
            symbol = market['symbol'];
            if (feeCurrency === undefined) {
                feeCurrency = market['quote'];
            }
        }
        const remaining = this.safeFloat (order, 'left');
        const status = this.parseOrderStatus (this.safeString (order, 'status'));
        const type = this.safeString (order, 'order_type');
        const side = this.safeString (order, 'type');
        return {
            'id': this.safeString (order, 'id'),
            'datetime': this.iso8601 (timestamp),
            'timestamp': timestamp,
            'lastTradeTimestamp': undefined,
            'status': status,
            'symbol': symbol,
            'type': type,
            'side': side,
            'price': price,
            'cost': cost,
            'average': average,
            'amount': amount,
            'filled': filled,
            'remaining': remaining,
            'trades': undefined,
            'fee': {
                'currency': feeCurrency,
                'cost': this.safeFloat (order, 'deal_fee'),
            },
            'info': order,
        };
    }

    async fetchOrdersByStatus (status, symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        if (limit === undefined) {
            limit = 100;
        }
        const request = {
            'page': 1,
            'limit': limit,
        };
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['market'] = market['id'];
        }
        const method = 'privateGetOrder' + this.capitalize (status);
        const response = await this[method] (this.extend (request, params));
        return this.parseOrders (response['data']['data'], market, since, limit);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        return await this.fetchOrdersByStatus ('pending', symbol, since, limit, params);
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        const request = {
            'id': id,
        };
        const response = await this.privateGetOrdersId (this.extend (request, params));
        return this.parseOrder (response['data']);
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        const request = {
            'id': id,
        };
        return this.privateDeleteOrdersId (this.extend (request, params));
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        if (limit === undefined) {
            limit = 100;
        }
        const request = {
            'page': 1,
            'limit': limit,
        };
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['market'] = market['id'];
        }
        const response = await this.privateGetOrderUserDeals (this.extend (request, params));
        return this.parseTrades (response['data']['data'], market, since, limit);
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        path = this.implodeParams (path, params);
        let url = this.urls['api'] + '/' + path;
        let query = this.omit (params, this.extractParams (path));
        if (api === 'public') {
            if (Object.keys (query).length) {
                url += '?' + this.urlencode (query);
            }
        } else {
            this.checkRequiredCredentials ();
            query = this.keysort (query);
            const urlencoded = this.urlencode (query);
            headers = {
                'X-API-KEY': this.apiKey,
                'Content-Type': 'application/json',
            };
            if ((method === 'GET') || (method === 'DELETE')) {
                url += '?' + urlencoded;
            } else {
                body = this.json (query);
            }
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }

    handleErrors (httpCode, reason, url, method, headers, body, response, requestHeaders, requestBody) {
        if (response === undefined) {
            return; // resort to defaultErrorHandler
        }
        // typical error response: {"result":false,"code":"401"}
        if (httpCode === 200) {
            return; // success
        }
        if (httpCode >= 400) {
            return; // resort to defaultErrorHandler
        }
        const message = this.safeValue (response, 'message');
        if (message === undefined) {
            return; // either public API (no error codes expected) or success
        }
        const feedback = this.id + ' ' + message;
        this.throwExactlyMatchedException (this.exceptions, httpCode, feedback);
        throw new ExchangeError (feedback); // unknown message
    }
};
