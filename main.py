# RestAPIのテスト
import requests, json, time
import random
base_url = 'https://otoge-realtime-battle.onrender.com'

def login(username=None):
    if type(username) == str:
        payload = {'username':username}
        url = f"{base_url}/api/connect"
        res = requests.post(url, json=payload)
        return res
    return False

def get_rooms(idx=None):
    ret = None
    tmp = requests.get(base_url + '/api/rooms')
    for i,r in enumerate(tmp.json()):
        print(i, r['id'], r['name'], r['rule'], r['memberCount'])
        if idx is not None and idx == i:
            ret = r['id']
    return ret

def join_room(roomid=None, userid=None, password=None):
    payload = {'userId':userid}
    if password is not None:
        payload['password'] = password
    url = f"{base_url}/api/rooms/{roomid}/join"
    res = requests.post(url, json=payload)
    return res

def leave_room(roomid=None,userid=None):
    payload = {'userId':userid}
    url = f"{base_url}/api/rooms/{roomid}/leave"
    res = requests.post(url, json=payload)
    return res

def send_score(roomid=None, userid=None, score=0, exscore=0):
    payload = {'userId':userid, 'normalScore':score, 'exScore':exscore}
    url = f"{base_url}/api/rooms/{roomid}/score"
    header = {'Content-Type':'application/json'}
    res = requests.post(url, json=payload, headers=header)
    return res

def finish_song(roomid=None,userid=None):
    payload = {'userId':userid}
    url = f"{base_url}/api/rooms/{roomid}/finish"
    res = requests.post(url, json=payload)
    return res

if __name__ == "__main__":
    print("Hello from otoge-realtime-battle!")

    userid = login('ファイヤー').json()['userId']
    roomid = get_rooms(0)
    userid2 = login('最強男').json()['userId']
    join_room(roomid, userid2)
    join_room(roomid, userid)
    for i in range(1): # 1試合
        for sc in range(40):
            base = 10000000/40*sc
            ran1 = random.randint(0, 50000)-25000
            ran2 = random.randint(0, 50000)-25000
            sc1 = max(min(base+ran1, 10000000), 0)
            sc2 = max(min(base+ran2, 10000000), 0)
            send_score(roomid, userid, sc1, 0)
            send_score(roomid, userid2, sc2, 0)
            time.sleep(0.01)
        time.sleep(1)
        finish_song(roomid, userid)
        finish_song(roomid, userid2)
    leave_room(roomid, userid)
    leave_room(roomid, userid2)
