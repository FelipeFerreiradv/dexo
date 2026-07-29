"""Unittests do pos-processamento topologico da mascara (mask_postprocess.py).

Stdlib unittest + numpy/cv2 apenas — roda em QUALQUER ambiente com as deps do
sidecar, sem FastAPI e sem carregar o modelo. Dentro da imagem:

    docker run --rm -v "$PWD/infra/rembg:/src" dexo-rembg-bench \
      python -m unittest discover /src/tests -v

Fixtures 100% sinteticas (numpy puro), deterministicas.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mask_postprocess import MaskPostprocessConfig, postprocess_mask  # noqa: E402

CFG_ON = MaskPostprocessConfig(enabled=True)


def make_rgba(h=200, w=300):
    """Canvas RGBA transparente com RGB cinza-medio."""
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = 128
    return rgba


def add_rect(rgba, y0, y1, x0, x1, alpha=255, rgb=None):
    rgba[y0:y1, x0:x1, 3] = alpha
    if rgb is not None:
        rgba[y0:y1, x0:x1, :3] = rgb
    return rgba


class TestKillswitch(unittest.TestCase):
    def test_disabled_devolve_o_mesmo_objeto(self):
        rgba = add_rect(make_rgba(), 50, 150, 50, 150)
        cfg = MaskPostprocessConfig(enabled=False)
        out = postprocess_mask(rgba, cfg)
        self.assertIs(out, rgba)  # identidade absoluta, nem copia

    def test_alpha_todo_vazio_e_intocado(self):
        rgba = make_rgba()
        out = postprocess_mask(rgba, CFG_ON)
        self.assertIs(out, rgba)

    def test_shape_inesperado_e_intocado(self):
        rgb = np.zeros((50, 50, 3), dtype=np.uint8)
        out = postprocess_mask(rgb, CFG_ON)
        self.assertIs(out, rgb)


class TestComponentes(unittest.TestCase):
    def test_speck_removido_blob_intacto(self):
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=255)  # peca: 120x120 = 14400px
        add_rect(rgba, 10, 14, 250, 254, alpha=255)  # speck: 4x4 = 16px
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[11, 251, 3]), 0)  # speck morreu
        self.assertEqual(int(out[100, 100, 3]), 255)  # peca intacta

    def test_multi_parte_legitima_sobrevive(self):
        # 2a parte com 40x40=1600px = 11% da maior (14400px) => acima dos 5%.
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=255)
        add_rect(rgba, 60, 100, 220, 260, alpha=255)
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[80, 240, 3]), 255)  # parte 2 preservada

    def test_borda_suave_do_blob_e_preservada(self):
        # Anel de alpha suave (60) de 3px em volta do solido: fica DENTRO da
        # keep-mask dilatada (8px) e nao pode ser zerado.
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=60)  # "anel" por baixo
        add_rect(rgba, 43, 157, 43, 157, alpha=255)  # nucleo solido
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[41, 100, 3]), 60)  # suave preservado
        # Alpha suave LONGE de qualquer componente (fora da dilatacao) morre:
        rgba2 = make_rgba()
        add_rect(rgba2, 40, 160, 40, 160, alpha=255)
        add_rect(rgba2, 20, 180, 200, 290, alpha=40)  # nevoa sem nucleo solido
        out2 = postprocess_mask(rgba2, CFG_ON)
        self.assertEqual(int(out2[100, 250, 3]), 0)  # nevoa some
        self.assertEqual(int(out2[100, 100, 3]), 255)


class TestFuros(unittest.TestCase):
    # Furos 3x3 = 9px: abaixo do teto 0.001 x 14400 = 14.4px do blob 120x120.
    def test_furo_ruido_e_preenchido(self):
        # Furo com alpha intermediario (90): ruido do modelo => preenche.
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=255)
        add_rect(rgba, 95, 98, 95, 98, alpha=90)
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[96, 96, 3]), 255)

    def test_furo_real_de_parafuso_e_preservado(self):
        # Furo do MESMO tamanho com alpha ~0: o modelo CRAVOU vazio => e' a
        # regra do alpha medio (nao a de area) que o preserva.
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=255)
        add_rect(rgba, 95, 98, 95, 98, alpha=0)
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[96, 96, 3]), 0)

    def test_furo_grande_nunca_e_preenchido(self):
        # Furo 60x60 (3600px) >> 0.1% da maior componente => fora do limiar de
        # PREENCHIMENTO. A nevoa de alpha intermediario dentro dele vira
        # TRANSPARENTE (fundo visto por uma abertura grande e' limpo pelo
        # keep-mask) — o invariante e' nunca virar OPACO.
        rgba = make_rgba(300, 300)
        add_rect(rgba, 20, 280, 20, 280, alpha=255)
        add_rect(rgba, 120, 180, 120, 180, alpha=90)
        out = postprocess_mask(rgba, CFG_ON)
        self.assertEqual(int(out[150, 150, 3]), 0)  # limpo, jamais 255


class TestSombra(unittest.TestCase):
    """O caso real (foto B): sombra DENSA (alpha >= bin_thresh) que o modelo
    inclui CONECTADA a base da peca — sobrevive ao filtro de componentes por
    ser parte da silhueta principal; so a supressao (opt-in) a ataca."""

    def _cena(self, shadow_rgb=70):
        rgba = make_rgba(200, 300)
        add_rect(rgba, 20, 100, 100, 200, alpha=255, rgb=180)  # peca
        # sombra adjacente (conectada), alpha 160, dentro de [lo, hi]:
        add_rect(rgba, 100, 160, 100, 200, alpha=160, rgb=shadow_rgb)
        return rgba

    def test_sombra_projetada_atenuada_quando_flag_on(self):
        cfg = MaskPostprocessConfig(enabled=True, shadow_suppress=True)
        out = postprocess_mask(self._cena(), cfg)
        self.assertLess(int(out[140, 150, 3]), 30)  # 160 * 0.15 = 24
        self.assertEqual(int(out[50, 150, 3]), 255)  # peca (alpha > hi) intacta

    def test_sombra_NAO_atenuada_sem_a_flag_propria(self):
        out = postprocess_mask(self._cena(), CFG_ON)  # so master ON
        self.assertEqual(int(out[140, 150, 3]), 160)

    def test_regiao_colorida_nao_e_tratada_como_sombra(self):
        cfg = MaskPostprocessConfig(enabled=True, shadow_suppress=True)
        rgba = make_rgba(200, 300)
        add_rect(rgba, 20, 100, 100, 200, alpha=255, rgb=180)
        # regiao saturada (vermelha) adjacente: nao e' sombra cinza.
        rgba[100:160, 100:200, 3] = 160
        rgba[100:160, 100:200, 0] = 200
        rgba[100:160, 100:200, 1] = 40
        rgba[100:160, 100:200, 2] = 40
        out = postprocess_mask(rgba, cfg)
        self.assertEqual(int(out[140, 150, 3]), 160)  # intocada


class TestInvariantes(unittest.TestCase):
    def test_rgb_nunca_muda(self):
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=255, rgb=200)
        add_rect(rgba, 10, 14, 250, 254, alpha=255, rgb=50)
        rgb_before = rgba[..., :3].copy()
        out = postprocess_mask(rgba, CFG_ON)
        np.testing.assert_array_equal(out[..., :3], rgb_before)

    def test_fundo_solido_tipico_e_quase_identidade(self):
        # 1 componente, sem specks, sem furos-ruido: saida == entrada.
        rgba = make_rgba()
        add_rect(rgba, 40, 160, 40, 160, alpha=60)
        add_rect(rgba, 43, 157, 43, 157, alpha=255)
        out = postprocess_mask(rgba, CFG_ON)
        np.testing.assert_array_equal(out, rgba)

    def test_from_env_defaults(self):
        cfg = MaskPostprocessConfig.from_env()
        self.assertFalse(cfg.enabled)  # default OFF — zero regressao
        self.assertFalse(cfg.shadow_suppress)


if __name__ == "__main__":
    unittest.main()
