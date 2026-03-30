# -*- coding: utf-8 -*-
import pandas as pd
p = r"c:\\Users\\Casa\\Downloads\\Anuncios-2026_03_28-23_52.xlsx"
df = pd.read_excel(p, sheet_name="Anúncios")
print('Shape', df.shape)
print(df.head(5))
print(df.columns)
