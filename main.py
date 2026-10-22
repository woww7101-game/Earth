import os, re, secrets, hashlib, hmac, time
from datetime import datetime, timezone, timedelta
from typing import Optional
import requests
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

APP_NAME = "TerraWeather"
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret-before-deploying")
MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "terraweather")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OPENWEATHER_TILE_LAYER = os.getenv("OPENWEATHER_TILE_LAYER", "temp_new")
CESIUM_ION_TOKEN = os.getenv("CESIUM_ION_TOKEN", "")

app = FastAPI(title=APP_NAME)
app.mount('/static', StaticFiles(directory='static'), name='static')
serializer = URLSafeTimedSerializer(SECRET_KEY, salt="terraweather-session")
client = None
users = saved_places = None
if MONGODB_URI:
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        client.admin.command('ping')
        db = client[MONGODB_DB_NAME]
        users = db.users
        saved_places = db.saved_places
        users.create_index('username_key', unique=True)
        users.create_index('email_key', unique=True)
        saved_places.create_index([('user_id', 1), ('created_at', -1)])
    except Exception as exc:
        print('MongoDB initialization failed:', exc)

class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)

class LoginBody(BaseModel):
    login: str
    password: str

class PlaceBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)

class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


def require_db():
    if users is None:
        raise HTTPException(503, 'MongoDB не подключена. Настрой MONGODB_URI и MONGODB_DB_NAME в Render.')

def hash_password(password: str, salt: Optional[str] = None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 310000).hex()
    return f'{salt}${digest}'

def verify_password(password: str, stored: str):
    try:
        salt, digest = stored.split('$', 1)
        return hmac.compare_digest(hash_password(password, salt).split('$', 1)[1], digest)
    except Exception:
        return False

def token_for(user):
    return serializer.dumps({'uid': str(user['_id']), 'username': user['username']})

def current_user(request: Request):
    auth = request.headers.get('authorization', '')
    token = auth[7:] if auth.lower().startswith('bearer ') else request.cookies.get('tw_session', '')
    if not token:
        raise HTTPException(401, 'Войди в аккаунт')
    try:
        data = serializer.loads(token, max_age=60*60*24*30)
    except (BadSignature, SignatureExpired):
        raise HTTPException(401, 'Сессия истекла. Войди снова.')
    require_db()
    from bson import ObjectId
    user = users.find_one({'_id': ObjectId(data['uid'])}, {'password_hash': 0})
    if not user:
        raise HTTPException(401, 'Пользователь не найден')
    return user

def user_json(u):
    return {'id': str(u['_id']), 'username': u['username'], 'email': u['email']}

def weather_at(lat, lon):
    if not OPENWEATHER_API_KEY:
        raise HTTPException(503, 'Добавь OPENWEATHER_API_KEY в Render Environment.')
    try:
        current = requests.get('https://api.openweathermap.org/data/2.5/weather', params={'lat':lat,'lon':lon,'appid':OPENWEATHER_API_KEY,'units':'metric'}, timeout=12)
        forecast = requests.get('https://api.openweathermap.org/data/2.5/forecast', params={'lat':lat,'lon':lon,'appid':OPENWEATHER_API_KEY,'units':'metric'}, timeout=12)
        current.raise_for_status(); forecast.raise_for_status()
        c, f = current.json(), forecast.json()
        return {
          'name': c.get('name') or f"{lat:.3f}, {lon:.3f}", 'lat':lat,'lon':lon,
          'temp': round(c['main']['temp']), 'feels_like': round(c['main']['feels_like']),
          'description': c['weather'][0]['description'].capitalize(), 'icon':c['weather'][0]['icon'],
          'main': c['weather'][0]['main'].lower(), 'humidity':c['main']['humidity'],
          'wind':round(c.get('wind',{}).get('speed',0),1), 'pressure':c['main'].get('pressure'),
          'sunrise':c['sys'].get('sunrise'), 'sunset':c['sys'].get('sunset'), 'timezone':c.get('timezone',0),
          'country':c.get('sys',{}).get('country',''),
          'forecast':[{'time':x['dt'],'temp':round(x['main']['temp']),'description':x['weather'][0]['description'],'icon':x['weather'][0]['icon'],'main':x['weather'][0]['main'].lower()} for x in f.get('list',[]) if '12:00:00' in x.get('dt_txt','')][:5]
        }
    except requests.RequestException as e:
        raise HTTPException(502, f'OpenWeather не ответил: {e.__class__.__name__}')

def geocode(q):
    if not OPENWEATHER_API_KEY:
        raise HTTPException(503, 'Добавь OPENWEATHER_API_KEY в Render Environment.')
    if re.fullmatch(r'\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*', q):
        a,b=map(float,q.split(','))
        if not -90<=a<=90 or not -180<=b<=180: raise HTTPException(400,'Координаты вне диапазона')
        return {'name':f'{a:.4f}, {b:.4f}','lat':a,'lon':b}
    try:
        r=requests.get('https://api.openweathermap.org/geo/1.0/direct',params={'q':q,'limit':5,'appid':OPENWEATHER_API_KEY},timeout=12);r.raise_for_status(); arr=r.json()
        if not arr: raise HTTPException(404,'Место не найдено')
        return [{'name':', '.join(x for x in [a.get('name'),a.get('state'),a.get('country')] if x),'lat':a['lat'],'lon':a['lon']} for a in arr]
    except requests.RequestException:
        raise HTTPException(502,'Не удалось выполнить поиск места')

@app.get('/', response_class=HTMLResponse)
def index():
    with open('index.html',encoding='utf-8') as f: return f.read()

@app.get('/api/config')
def config():
    return {'app_name':APP_NAME,'cesium_token':CESIUM_ION_TOKEN,'openweather_configured':bool(OPENWEATHER_API_KEY),'groq_configured':bool(GROQ_API_KEY),'database_configured':users is not None,'weather_tile_layer':OPENWEATHER_TILE_LAYER}

@app.get('/api/health')
def health():
    db_ok=False
    try:
        if client: client.admin.command('ping'); db_ok=True
    except Exception: pass
    return {'status':'ok','database_connected':db_ok,'openweather_configured':bool(OPENWEATHER_API_KEY),'groq_configured':bool(GROQ_API_KEY),'cesium_configured':bool(CESIUM_ION_TOKEN)}

@app.post('/api/register')
def register(body:RegisterBody):
    require_db()
    username=body.username.strip(); email=body.email.strip().lower()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{3,24}',username): raise HTTPException(400,'Имя: 3–24 символа, латиница, цифры, точка, дефис или _')
    if '@' not in email: raise HTTPException(400,'Проверь email')
    doc={'username':username,'username_key':username.lower(),'email':email,'email_key':email,'password_hash':hash_password(body.password),'created_at':datetime.now(timezone.utc)}
    try: users.insert_one(doc)
    except Exception as e:
        if 'duplicate key' in str(e).lower(): raise HTTPException(409,'Такое имя пользователя или email уже зарегистрированы')
        raise HTTPException(500,'Не удалось сохранить регистрацию')
    u=users.find_one({'username_key':username.lower()})
    return {'token':token_for(u),'user':user_json(u)}

@app.post('/api/login')
def login(body:LoginBody):
    require_db(); value=body.login.strip().lower()
    u=users.find_one({'$or':[{'username_key':value},{'email_key':value}]})
    if not u or not verify_password(body.password,u['password_hash']): raise HTTPException(401,'Неверное имя/email или пароль')
    return {'token':token_for(u),'user':user_json(u)}

@app.get('/api/me')
def me(u=Depends(current_user)): return {'user':user_json(u)}

@app.get('/api/weather')
def get_weather(lat:float,lon:float,u=Depends(current_user)): return weather_at(lat,lon)

@app.get('/api/search')
def search_place(q:str,u=Depends(current_user)): return {'results':geocode(q) if not re.fullmatch(r'\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*',q) else [geocode(q)]}

@app.get('/api/saved')
def get_saved(u=Depends(current_user)):
    require_db(); return {'places':[{'id':str(x['_id']),'name':x['name'],'lat':x['lat'],'lon':x['lon']} for x in saved_places.find({'user_id':str(u['_id'])}).sort('created_at',DESCENDING)]}

@app.post('/api/saved')
def save_place(body:PlaceBody,u=Depends(current_user)):
    require_db(); doc={'user_id':str(u['_id']),'name':body.name,'lat':body.lat,'lon':body.lon,'created_at':datetime.now(timezone.utc)}
    existing=saved_places.find_one({'user_id':doc['user_id'],'lat':body.lat,'lon':body.lon})
    if existing: return {'id':str(existing['_id']),'saved':True}
    result=saved_places.insert_one(doc); return {'id':str(result.inserted_id),'saved':True}

@app.delete('/api/saved/{place_id}')
def delete_saved(place_id:str,u=Depends(current_user)):
    require_db()
    from bson import ObjectId
    if not ObjectId.is_valid(place_id): raise HTTPException(400,'Некорректный ID')
    saved_places.delete_one({'_id':ObjectId(place_id),'user_id':str(u['_id'])}); return {'ok':True}

@app.post('/api/ai')
def ask_ai(body:ChatBody,u=Depends(current_user)):
    if not GROQ_API_KEY: raise HTTPException(503,'Добавь GROQ_API_KEY в Render Environment.')
    try:
        r=requests.post('https://api.groq.com/openai/v1/chat/completions',headers={'Authorization':f'Bearer {GROQ_API_KEY}','Content-Type':'application/json'},json={'model':GROQ_MODEL,'temperature':0.4,'messages':[{'role':'system','content':'Ты TerraWeather — помощник по Земле и погоде. Если пользователь просит показать место, верни в ответе отдельную строку строго в формате [MAP: latitude, longitude | place name], если координаты можно определить из контекста. Не выдумывай точные координаты неизвестных мест; попроси уточнить. Отвечай на языке пользователя. Погоду не выдумывай: для точной текущей погоды попроси пользователя открыть точку/карточку, или используй координаты из запроса и объясни, что погода проверяется отдельно.'},{'role':'user','content':body.message}]},timeout=30)
        r.raise_for_status(); return {'reply':r.json()['choices'][0]['message']['content']}
    except requests.RequestException: raise HTTPException(502,'Groq временно недоступен')

@app.get('/api/tiles/{z}/{x}/{y}.png')
def weather_tile(z:int,x:int,y:int):
    if not OPENWEATHER_API_KEY: raise HTTPException(503,'OpenWeather tiles are not configured')
    if not (0<=z<=18 and 0<=x<2**z and 0<=y<2**z): raise HTTPException(400,'Invalid tile coordinates')
    layer=OPENWEATHER_TILE_LAYER if OPENWEATHER_TILE_LAYER in {'temp_new','clouds_new','precipitation_new','wind_new','pressure_new'} else 'temp_new'
    try:
        r=requests.get(f'https://tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png',params={'appid':OPENWEATHER_API_KEY},timeout=12)
        if r.status_code!=200: raise HTTPException(502,'OpenWeather tile unavailable; check API plan and key')
        from fastapi.responses import Response
        return Response(content=r.content,media_type='image/png',headers={'Cache-Control':'public, max-age=300'})
    except requests.RequestException: raise HTTPException(502,'OpenWeather tile request failed')
