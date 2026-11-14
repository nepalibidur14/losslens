"""LossLens fixed helpers, uploaded to each shop's Daytona sandbox as /tmp/shop/losslens.py.

The forecast (via Claude's run_python), the 30-day backtest and test.ts all use these same functions,
so the numbers are stable and do not depend on AI-written code.
"""
import math

import jpholiday
import numpy as np
import pandas as pd

CSV_PATH = '/tmp/shop/sales.csv'
MIN_SIMILAR = 5  # fewer similar days than this -> relax a filter

EN = {
    'メロンパン': 'Melon pan', 'クロワッサン': 'Croissant', 'あんパン': 'Anpan', 'カレーパン': 'Curry bread',
    '食パン(1斤)': 'Shokupan loaf', '塩パン': 'Salt bread', 'チョコデニッシュ': 'Choco danish', 'サンドイッチ': 'Sandwich',
}
WEATHER_EN = {'晴れ': 'Sunny', '曇り': 'Cloudy', '雨': 'Rainy'}
WEEKDAY_JP = '月火水木金土日'


def day_type(d) -> str:
    """'weekend_or_holiday' for Saturday, Sunday or a Japanese public holiday (jpholiday), else 'weekday'."""
    x = pd.Timestamp(d).date()
    return 'weekend_or_holiday' if x.weekday() >= 5 or jpholiday.is_holiday(x) else 'weekday'


def load(path: str = CSV_PATH) -> pd.DataFrame:
    df = pd.read_csv(path, encoding='utf-8-sig')
    df['date'] = pd.to_datetime(df['date'])
    df['holiday'] = df['holiday'].fillna('').astype(str).str.strip()
    df['sold_total'] = df['sold_full_price'] + df['sold_half_price']
    weekend = df['date'].dt.weekday >= 5
    df['day_type'] = np.where(weekend | (df['holiday'] == '祝'), 'weekend_or_holiday', 'weekday')
    return df


def holiday_mismatches(df: pd.DataFrame) -> list:
    """Days where the CSV 祝 column and jpholiday disagree (should be empty)."""
    days = df.drop_duplicates('date')
    out = []
    for d, h in zip(days['date'], days['holiday']):
        csv_h, jp_h = h == '祝', jpholiday.is_holiday(d.date())
        if csv_h != jp_h:
            out.append(f"{d.date()} csv={'祝' if csv_h else '-'} jpholiday={jp_h}")
    return out


def _month_gap(months: pd.Series, m: int) -> pd.Series:
    g = (months - m).abs()
    return np.minimum(g, 12 - g)  # Dec <-> Jan is 1 month apart


def similar_days(df, item, date, weather=None, before=None, use_season=True) -> pd.DataFrame:
    """Past rows for `item` with the same day type, same weather (if given) and same season (±1 month).
    Only rows before `before` (default: before `date`) are used, so there is no look-ahead."""
    target = pd.Timestamp(date)
    cutoff = pd.Timestamp(before) if before is not None else target
    sub = df[(df['item'] == item) & (df['date'] < cutoff) & (df['day_type'] == day_type(target))]
    if use_season:
        sub = sub[_month_gap(sub['date'].dt.month, target.month) <= 1]
    if weather:
        sub = sub[sub['weather'] == weather]
    return sub


def suggest(df, item, date, weather=None, before=None) -> dict:
    """How many to make on `date`: a range from similar past days, the usual batch and the estimated saving."""
    if item not in set(df['item']):
        return {'item': item, 'no_data': True, 'message': 'no past data for this item'}
    target = pd.Timestamp(date)
    cutoff = pd.Timestamp(before) if before is not None else target
    relaxed = []
    sim = similar_days(df, item, target, weather, before)
    if weather and len(sim) < MIN_SIMILAR:
        sim = similar_days(df, item, target, None, before)
        relaxed.append('weather')
    if len(sim) < MIN_SIMILAR:
        sim = similar_days(df, item, target, None, before, use_season=False)
        relaxed.append('season')
    if sim.empty:
        return {'item': item, 'no_data': True, 'message': 'no past data for this item'}

    sold = sim['sold_total']
    low = int(math.floor(sold.quantile(0.25)))
    high = int(math.ceil(sold.quantile(0.75)))

    # Usual batch = median made for this item on the same day type in the 28 days before the cutoff.
    dtype = day_type(target)
    item_rows = df[(df['item'] == item) & (df['date'] < cutoff)]
    recent = item_rows[(item_rows['date'] >= cutoff - pd.Timedelta(days=28)) & (item_rows['day_type'] == dtype)]
    if recent.empty:
        recent = item_rows.tail(7)
    usual = int(round(recent['made'].median()))
    last = item_rows.iloc[-1]
    unit_cost, price = int(last['unit_cost_yen']), int(last['price_yen'])

    # Expected daily saving if the shop bakes the top of the range instead of the usual batch,
    # judged on the similar days: less waste cost, minus profit lost when it sells out.
    waste_usual = np.maximum(usual - sold, 0).mean()
    waste_high = np.maximum(high - sold, 0).mean()
    lost_usual = np.maximum(sold - usual, 0).mean()
    lost_high = np.maximum(sold - high, 0).mean()
    saving = (waste_usual - waste_high) * unit_cost - (lost_high - lost_usual) * (price - unit_cost)

    return {
        'item': item,
        'en': EN.get(item, item),
        'date': target.date().isoformat(),
        'weekday': WEEKDAY_JP[target.weekday()],
        'day_type': dtype,
        'holiday_name': jpholiday.is_holiday_name(target.date()) or '',
        'weather': weather or '',
        'relaxed_filters': relaxed,
        'similar_days': {
            'count': int(len(sim)),
            'avg_sold': round(float(sold.mean()), 1),
            'avg_wasted': round(float(sim['wasted'].mean()), 1),
            'avg_made': round(float(sim['made'].mean()), 1),
        },
        'suggest_low': low,
        'suggest_high': high,
        'usual_batch': usual,
        'unit_cost_yen': unit_cost,
        'price_yen': price,
        'est_daily_saving_yen': int(round(saving)),
        'method': 'Range = 25th-75th percentile of total sold on similar past days. '
                  'Sold counts are capped by how many were made, so real demand can be a little higher.',
    }


def backtest(df=None, days: int = 30) -> dict:
    """Replay the last `days` days: each day, bake the top of the suggested range (using only earlier data
    and that day's weather) and compare waste cost with what really happened."""
    if df is None:
        df = load()
    end = df['date'].max()
    start = end - pd.Timedelta(days=days - 1)
    per = {}
    for _, r in df[df['date'] >= start].iterrows():
        s = suggest(df, r['item'], r['date'], r['weather'], before=r['date'])
        if s.get('no_data'):
            continue
        bake = s['suggest_high']
        demand = int(r['sold_total'])
        cost, price = int(r['unit_cost_yen']), int(r['price_yen'])
        p = per.setdefault(r['item'], {'actual': 0, 'sim': 0, 'lost': 0})
        p['actual'] += int(r['wasted']) * cost
        p['sim'] += max(0, bake - demand) * cost
        p['lost'] += max(0, demand - bake) * (price - cost)
    items = [
        {'item': k, 'en': EN.get(k, k), 'actualWasteCost': v['actual'], 'simWasteCost': v['sim'],
         'lostSales': v['lost'], 'netSaving': v['actual'] - v['sim'] - v['lost']}
        for k, v in per.items()
    ]
    items.sort(key=lambda x: -x['netSaving'])
    actual = sum(i['actualWasteCost'] for i in items)
    sim = sum(i['simWasteCost'] for i in items)
    lost = sum(i['lostSales'] for i in items)
    return {
        'days': days,
        'from': start.date().isoformat(),
        'to': end.date().isoformat(),
        'actualWasteCost': actual,
        'simWasteCost': sim,
        'wasteSaved': actual - sim,
        'lostSales': lost,
        'netSaving': actual - sim - lost,
        'perItem': items,
        'method': 'Each day, bake the top of the suggested range (75th percentile of sold on similar earlier days, '
                  "using that day's real weather). Waste = baked - sold. Lost sales = profit (price - cost) on units "
                  'that would have sold out. Only data before each day is used.',
    }
