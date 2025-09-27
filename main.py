# RestAPIのテスト
import requests, json, time
import random
import threading, queue
base_url = 'https://otoge-realtime-battle.onrender.com'

# tcp接続を再利用
session = requests.Session()

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
    res = requests.post(url, json=payload)
    return res

def send_score_thread(roomid, userid, score, exscore):
    return send_score(roomid, userid, score, exscore)

def finish_song(roomid=None,userid=None):
    payload = {'userId':userid}
    url = f"{base_url}/api/rooms/{roomid}/finish"
    res = requests.post(url, json=payload)
    return res

if __name__ == "__main__":
    print("Hello from otoge-realtime-battle!")
    threads = []

    userid = login('ファイヤー').json()['userId']
    roomid = get_rooms(0)
    userid2 = login('最強男').json()['userId']
    join_room(roomid, userid2)
    join_room(roomid, userid)
    NUM=72
    for i in range(1): # 1試合
        for sc in range(NUM):
            base = int(10000000/NUM*sc)
            ran1 = random.randint(0, 50000)-25000
            ran2 = random.randint(0, 50000)-25000
            sc1 = max(min(base+ran1, 10000000), 0)
            sc2 = max(min(base+ran2, 10000000), 0)
            t1 = threading.Thread(target=send_score_thread,
                                  args=(roomid, userid, sc1, 0))
            t2 = threading.Thread(target=send_score_thread,
                                  args=(roomid, userid2, sc2, 0))
            threads.append(t1)
            threads.append(t2)
            t1.start()
            t2.start()
            time.sleep(0.05)
        for thread in threads:
            thread.join()
        finish_song(roomid, userid)
        finish_song(roomid, userid2)
    leave_room(roomid, userid)
    leave_room(roomid, userid2)
