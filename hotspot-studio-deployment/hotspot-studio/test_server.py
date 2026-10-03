import importlib.util, json, os, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('studio',Path(__file__).with_name('server.py'))
studio=importlib.util.module_from_spec(spec);spec.loader.exec_module(studio)
class BackendTests(unittest.TestCase):
    def setUp(self):
        self.config=(studio.ROOT/'dist/example.config').read_text()
    def test_default(self): studio.validate(self.config)
    def test_reject_files_and_commands(self):
        for flag in ['-d /tmp/leak','-p /etc/passwd','-materials_file /etc/passwd','-grid_layer_file ../../etc/passwd']:
            with self.subTest(flag=flag),self.assertRaises(ValueError):studio.validate(self.config+'\n'+flag)
    def test_reject_invalid(self):
        for config in ['-ambient NaN','-t_chip -1','-grid_rows 129','-model_type grid\n-grid_rows 39','-model_secondary 1\n-model_type block','-use_microfluidic_cooling 1']:
            with self.subTest(config=config),self.assertRaises(ValueError):studio.validate(config)
    def test_artifact_downloads(self):
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            run_id='a'*32;folder=studio.RUNS/run_id;folder.mkdir()
            (folder/'gcc.steady').write_bytes(b'Core 320.0\n')
            (folder/'gcc.ttrace').write_bytes(b'partial trace')
            (folder/'result.json').write_text(json.dumps({'id':run_id,'status':'failed','steadyExitCode':0,'transientExitCode':1,'rows':[],'log':''}))
            try:
                handler=object.__new__(studio.Handler)
                handler.send=lambda status,body,kind='application/json',download=None:(status,body,kind,download)
                handler.path=f'/api/runs/{run_id}'
                status,body,_,_=studio.Handler.do_GET(handler)
                self.assertEqual(status,200)
                self.assertIn('gcc.steady',body['artifacts'])
                self.assertNotIn('gcc.ttrace',body['artifacts'])
                handler.path=f'/api/runs/{run_id}/artifacts/gcc.steady'
                status,body,kind,download=studio.Handler.do_GET(handler)
                self.assertEqual((status,body,kind,download),(200,b'Core 320.0\n','application/octet-stream','gcc.steady'))
                handler.path=f'/api/runs/{run_id}/artifacts/gcc.ttrace'
                status,_,_,_=studio.Handler.do_GET(handler)
                self.assertEqual(status,404)
            finally:
                studio.RUNS=old
    def test_real_run(self):
        if not (studio.HOTSPOT/'hotspot').exists():self.skipTest('HotSpot binary unavailable')
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            try:
                result=studio.run_simulation(self.config)
                self.assertEqual(result['status'],'completed',result['log']);self.assertGreater(len(result['rows']),0)
                folder=studio.RUNS/result['id'];self.assertEqual((folder/'submitted.config').read_text(),self.config)
                self.assertEqual(json.loads((folder/'result.json').read_text())['status'],'completed')
                for name in ['gcc.steady','gcc.ttrace']:
                    self.assertGreater((folder/name).stat().st_size,0)
                    self.assertEqual(result['artifacts'][name]['url'],f'/api/runs/{result["id"]}/artifacts/{name}')
                studio.LOCK.acquire()
                try:
                    with self.assertRaises(BlockingIOError):studio.run_simulation(self.config)
                finally:studio.LOCK.release()
            finally:studio.RUNS=old
if __name__=='__main__':unittest.main()
