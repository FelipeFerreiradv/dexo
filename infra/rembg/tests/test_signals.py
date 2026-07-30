"""Unittests dos sinais/score de confianca da mascara (mask_postprocess.py).

Mesmo contrato do test_postprocess.py: stdlib + numpy/cv2, roda na imagem do
sidecar sem carregar o modelo. Fixtures sinteticas deterministicas.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mask_postprocess import confidence_score, mask_signals  # noqa: E402


def blank(h=400, w=600):
    return np.zeros((h, w), dtype=np.uint8)


class TestSignals(unittest.TestCase):
    def test_mascara_limpa_score_alto(self):
        # Blob solido unico com anel de anti-alias fino: o caso "bom" tipico.
        a = blank()
        a[100:300, 150:450] = 255
        a[99, 150:450] = 120  # 1px de borda suave
        s = mask_signals(a)
        self.assertEqual(s["ncomp"], 1)
        self.assertEqual(s["border"], 0.0)
        self.assertLess(s["amb"], 0.01)
        self.assertGreaterEqual(confidence_score(s), 0.9)

    def test_mascara_nebulosa_score_baixo(self):
        # Metade do quadro em alpha intermediario = modelo em duvida.
        a = blank()
        a[100:300, 150:450] = 255
        a[0:200, :] = np.maximum(a[0:200, :], 128)  # nevoa densa por cima
        a[200:400, 0:100] = 100  # mais nevoa intermediaria
        s = mask_signals(a)
        self.assertGreater(s["amb"], 0.1)
        self.assertLess(confidence_score(s), 0.7)

    def test_fragmentos_espalhados_penalizam(self):
        # Varios componentes relevantes = vazamento de fundo.
        a = blank()
        a[100:300, 150:450] = 255
        for i in range(6):
            y = 10 + i * 60
            a[y : y + 30, 520:560] = 255  # 30x40 = 1200px > 0.1% (240px)
        s = mask_signals(a)
        self.assertGreaterEqual(s["ncomp"], 6)
        clean = blank()
        clean[100:300, 150:450] = 255
        self.assertLess(
            confidence_score(s), confidence_score(mask_signals(clean))
        )

    def test_moldura_tocada_penaliza(self):
        # Alpha alto colado na moldura do quadro = fundo incluido na mascara.
        a = np.full((400, 600), 255, dtype=np.uint8)
        s = mask_signals(a)
        self.assertEqual(s["border"], 1.0)
        self.assertGreater(s["cov"], 0.85)
        self.assertLessEqual(confidence_score(s), 0.65)

    def test_furos_penalizam(self):
        a = blank()
        a[50:350, 100:500] = 255
        # 24 furos de 20x20 = 9600px de furo em 120000px de fg (8%)
        for i in range(4):
            for j in range(6):
                y, x = 70 + i * 70, 130 + j * 60
                a[y : y + 20, x : x + 20] = 0
        s = mask_signals(a)
        self.assertGreater(s["holes"], 0.05)
        clean = blank()
        clean[50:350, 100:500] = 255
        self.assertLess(
            confidence_score(s), confidence_score(mask_signals(clean))
        )

    def test_deterministico_e_limitado(self):
        rng = np.random.default_rng(42)
        a = (rng.random((200, 300)) * 255).astype(np.uint8)
        s1, s2 = mask_signals(a), mask_signals(a)
        self.assertEqual(s1, s2)
        score = confidence_score(s1)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)

    def test_mascara_so_de_specks_score_zero(self):
        # Fragmentos sem ancora (cov>0 mas nenhum componente relevante): a
        # PIOR classe de mascara — sem o curto-circuito, escoraria ~0.95 e
        # envenenaria a calibracao do modo observacao.
        a = blank(500, 500)
        for i in range(10):
            for j in range(10):
                y, x = 10 + i * 48, 10 + j * 48
                a[y : y + 5, x : x + 5] = 255  # 100 specks de 25px
        s = mask_signals(a)
        self.assertEqual(s["ncomp"], 0)
        self.assertGreater(s["cov"], 0.001)
        self.assertEqual(confidence_score(s), 0.0)

    def test_alpha_vazio_nao_quebra(self):
        s = mask_signals(blank())
        self.assertEqual(s["ncomp"], 0)
        self.assertEqual(s["cov"], 0.0)
        # Sem foreground solido, a mascara e' inutil: confianca ZERO.
        self.assertEqual(confidence_score(s), 0.0)


if __name__ == "__main__":
    unittest.main()
