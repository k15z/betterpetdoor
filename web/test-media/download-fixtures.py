import urllib.request, urllib.parse, json, pathlib, html, re, hashlib, concurrent.futures
root=pathlib.Path('/workspace/shared/golden-gate/test-media')
fixtures=[
 ('dog-standing-leaves.jpg','Golden retriever stehfoto.jpg',True,'Full-body standing side view; warm coat against brown leaf background.'),
 ('dog-sitting-indoor.jpg','Sitting golden retriever.jpg',True,'Stationary seated retriever on an indoor floor, closer to waiting-at-door use.'),
 ('dog-standing-tucker.jpg','Golden Retriever standing Tucker.jpg',True,'Second standing pose, contrasting outdoor background and gold coat.'),
 ('dog-sitting-person.jpg','Golden Retriever sitting in front of a man (Barras).jpg',True,'Sitting retriever with human/background distraction.'),
 ('negative-brown-sofa.jpg','A brown sofa (2005-03-03).jpg',False,'Warm-color furniture negative to expose color/blob false positives.'),
 ('negative-orange-cat.jpg','Orange tabby cat laying down.jpg',False,'Warm-color fur and four-legged animal negative to test semantic dog-vs-cat distinction.')]
def get(url):
 req=urllib.request.Request(url,headers={'User-Agent':'GoldenGateTestFixtures/1.0 (private browser dog detector testing)'})
 with urllib.request.urlopen(req,timeout=60) as r: return r.read()
def work(args):
 name,title,positive,reason=args
 u='https://commons.wikimedia.org/w/api.php?'+urllib.parse.urlencode({'action':'query','format':'json','titles':'File:'+title,'prop':'imageinfo','iiprop':'url|extmetadata|size','iiurlwidth':'960'})
 info=next(iter(json.loads(get(u))['query']['pages'].values()))['imageinfo'][0]
 url=info.get('thumburl',info['url']); data=get(url)
 (root/name).write_bytes(data)
 meta=info['extmetadata']
 clean=lambda key: html.unescape(re.sub('<[^>]+>','',meta.get(key,{}).get('value','')))
 return {'file':name,'expectDog':positive,'reason':reason,'sourcePage':info['descriptionurl'],'downloadUrl':url,'originalUrl':info['url'],'author':clean('Artist'),'license':clean('LicenseShortName'),'licenseUrl':clean('LicenseUrl'),'attributionRequired':clean('AttributionRequired'),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'modifications':'Wikimedia-generated resized thumbnail when available; no local visual edits.'}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex: results=list(ex.map(work,fixtures))
(root/'sources.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n')
lines=['# Dog camera test media','', 'Six real photographs sourced from Wikimedia Commons on 2026-10-03. These are a small smoke-test set, not a validated accuracy benchmark. No dog-door footage, video, night/IR examples, or real camera performance is covered. Images are Wikimedia-generated resized thumbnails where available; no local visual edits. Keep attribution/license records with redistributed fixtures.','']
for x in results:
 lines += ['## '+x['file'], '- Expected: '+('dog present' if x['expectDog'] else 'no dog'), '- Selection: '+x['reason'], '- Author: '+x['author'], '- License: '+x['license']+' — '+x['licenseUrl'], '- Source: '+x['sourcePage'], '- Downloaded asset: '+x['downloadUrl'], '- Size: '+str(x['bytes'])+' bytes','']
lines += ['For CC BY-SA photographs, any distributed adaptations must retain the applicable share-alike terms. The source pages are the authority for licensing; author statements were not independently audited.','']
(root/'ATTRIBUTION.md').write_text('\n'.join(lines))
print(json.dumps(results,indent=2,ensure_ascii=False));print('TOTAL_BYTES',sum(x['bytes'] for x in results))
