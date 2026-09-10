"""Synthetic behavior checks for the portable performance helper."""
import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'summarize_trace.py'
spec = importlib.util.spec_from_file_location('summary', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture():
    span = dict(id='op', sessionId='root', track='shell', startTime=0, endTime=20000)
    sessions = [dict(metadata=dict(id='root', childIds=['child']),
                     turns=[dict(id='turn', startTime=5000, endTime=15000, status='complete')],
                     spans=[span]),
                dict(metadata=dict(id='child', parentId='root'),
                     turns=[dict(id='child-turn', startTime=6000, endTime=8000, status='complete')])]
    return sessions, span


class HelperTests(unittest.TestCase):
    def test_union(self):
        self.assertEqual(m.union_ms([(0, 10), (5, 15), (30, 40), (2, 3)]), 25)

    def test_invalid_bounds(self):
        for start, end in [(10, 0), (float('nan'), 10), (0, float('inf')), (False, 3)]:
            with self.assertRaises(ValueError):
                m.bounds(dict(startTime=start, endTime=end))

    def test_overlapping_turns(self):
        sessions, _ = fixture()
        sessions[0]['turns'] = [dict(id=str(i), startTime=a, endTime=b, status='complete')
                                 for i, (a, b) in enumerate([(0, 10000), (5000, 15000), (20000, 25000)])]
        result = m.summarize(sessions, 'root')
        self.assertEqual(result['scope']['activeTurnUnionSeconds'], 20)
        self.assertEqual(result['scope']['betweenTurnGapSeconds'], 5)

    def test_clipping_and_overlap(self):
        sessions, span = fixture()
        analysis = dict(path=dict(segments=[dict(start=0, end=12000, span=span),
                                            dict(start=10000, end=20000, span=span)]))
        result = m.summarize(sessions, 'root', 'turn', analysis)
        self.assertEqual(result['path']['coverageSeconds'], 10)
        self.assertEqual(result['path']['overlapSeconds'], 2)
        self.assertTrue(any('overlap' in w for w in result['warnings']))

    def test_incomplete_scope(self):
        sessions, _ = fixture()
        sessions[0]['turns'][0]['status'] = 'aborted'
        result = m.summarize(sessions, 'root', '1', dict(path=dict(segments=[])))
        self.assertEqual(result['path']['uncoveredSeconds'], 10)
        self.assertTrue(any('incomplete' in w for w in result['warnings']))

    def test_identity_resolution(self):
        sessions, _ = fixture()
        with self.assertRaises(ValueError):
            m.summarize([], 'missing')
        with self.assertRaises(ValueError):
            m.summarize([sessions[0], sessions[0]], 'root')

    def test_turn_resolution(self):
        sessions, _ = fixture()
        self.assertEqual(m.summarize(sessions, 'root', '1')['scope'],
                         m.summarize(sessions, 'root', 'turn')['scope'])
        with self.assertRaises(ValueError):
            m.summarize(sessions, 'root', '999')

    def test_no_payload(self):
        sessions, _ = fixture()
        sessions[0]['metadata']['title'] = 'PRIVATE'
        sessions[0]['turns'][0]['prompt'] = 'PRIVATE'
        self.assertNotIn('PRIVATE', str(m.summarize(sessions, 'root')))

    def test_grouped_operation(self):
        sessions, span = fixture()
        analysis = dict(path=dict(segments=[dict(start=5000, end=7000, span=span),
                                            dict(start=12000, end=15000, span=span)]))
        result = m.summarize(sessions, 'root', 'turn', analysis)
        operation = result['path']['topOperations'][0]
        self.assertEqual(operation['exposedSeconds'], 5)
        self.assertEqual(operation['normalizedSpanLifetimeSeconds'], 20)
        self.assertEqual(operation['scopeClippedLifetimeSeconds'], 10)
        self.assertEqual(operation['fragmentCount'], 2)

    def test_descendant_context(self):
        sessions, _ = fixture()
        sessions[0]['metadata']['childIds'].append('missing')
        result = m.summarize(sessions, 'root')
        self.assertEqual(result['descendantContext'][0]['turnsIntersectingScope'][0]['id'], 'child-turn')
        self.assertTrue(any('Missing descendant' in w for w in result['warnings']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
