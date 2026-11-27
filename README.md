# Wheeltop Profils

PWA (Chrome Android, Web Bluetooth) pour basculer le réglage fin par vitesse d'un dérailleur
**Wheeltop EDS TX** entre deux profils : **Roue** et **Trainer**.

- Deux gros boutons « Appliquer Roue / Trainer » : connexion, lecture, confirmation, sauvegarde, écriture des seules vitesses qui diffèrent, relecture et vérification.
- « Mémoriser la position actuelle » : enregistre les valeurs lues dans le dérailleur dans un profil.
- Écran **Réglage** : modifier et écrire une seule vitesse (avec sauvegarde et relecture).
- Écran **Test** : vitesse engagée, plateau, batteries, monter/descendre, Preview (aller-retour).
- **Données** : export/import JSON compatible drEDS (`drEDS-[date].json`), sauvegardes automatiques avec restauration, réglages de sécurité, journal Bluetooth, **mode démo** (dérailleur simulé).
- Pas de serveur : tout est stocké dans le navigateur (localStorage). Exportez régulièrement.

## Installation sur le téléphone

Web Bluetooth exige **HTTPS** (ou `localhost`). Le plus simple : GitHub Pages.

1. Sur GitHub : *Settings → Pages → Build and deployment → Deploy from a branch*, choisissez la branche et le dossier `/ (root)`.
   (Pages sur un dépôt privé nécessite un compte payant. Sinon : Netlify Drop ou Cloudflare Pages, en glissant le dossier.)
2. Ouvrez l'URL dans **Chrome** sur le téléphone, puis menu ⋮ → *Ajouter à l'écran d'accueil*.
3. Activez le Bluetooth et la localisation (Android l'exige pour le scan BLE).

En local sur un ordinateur : `npm run serve` puis http://localhost:8080.

## Appli Android (APK)

Le dossier `android/` contient une appli native qui embarque la même interface (copiée depuis la racine à chaque compilation).
La WebView d'Android ne gère pas Web Bluetooth : le Bluetooth y est fourni par un petit pont Kotlin
(`BleBridge.kt`), qui ne fait que transporter les octets. Le protocole et la sécurité restent dans `js/`.

- Pas besoin d'hébergement HTTPS ni de Chrome ; fonctionne hors ligne.
- Quand l'appli passe en arrière-plan, elle se déconnecte du dérailleur (après la fin de l'opération en cours) pour
  laisser la place à l'appli officielle. Elle se reconnecte au prochain bouton utilisé.
- Export : le fichier est enregistré dans **Téléchargements**. Import : sélecteur de fichiers Android.
- Signature : clé fixe `android/keystore/wheeltop-debug.jks` (mot de passe `android`, non secrète). Elle permet d'installer
  une nouvelle version par-dessus l'ancienne **sans perdre les profils**. Désinstaller l'appli efface les profils : exportez avant.

Compilation :
- **GitHub Actions** : onglet *Actions → APK Android → Run workflow*, puis télécharger l'artefact `wheeltop-profils-apk`.
- **En local** (SDK Android installé, plateforme 34) : `cd android && ./gradlew assembleRelease`,
  APK dans `android/app/build/outputs/apk/release/`.

Installation sur le téléphone : copier l'APK, l'ouvrir, autoriser « installer des applis inconnues » pour l'appli qui l'ouvre,
puis au premier lancement autoriser « Appareils à proximité ».

## Procédure de test conseillée sur le vélo (vélo sur pied)

Essayez d'abord le **mode démo** (Données → Mode démo) pour prendre l'appli en main.

1. **Connexion + lecture seule** : réveillez le dérailleur (secouez le vélo), « Connecter », choisissez `EDS TX`.
   Vérifiez : firmware, nombre de vitesses, vitesse engagée, batteries. Exportez un JSON tout de suite (sauvegarde de référence).
2. **Valeurs par vitesse** : écran Réglage. Comparez avec drEDS ou l'appli officielle. Vérifiez que la *vitesse 1 = plus grand pignon* et que le point ● suit la vitesse quand vous changez avec la manette.
3. **Sens de changement** : écran Test, « Monter » doit aller vers un pignon **plus petit**. (Les sources drEDS se contredisent, voir plus bas.)
4. **Écriture d'une seule vitesse** : changez une vitesse de ±5, « Écrire », vérifiez le résumé, puis « Preview » pour voir le dérailleur se déplacer. Remettez la valeur d'origine.
5. **Profils** : « Mémoriser » en Roue ; montez sur le trainer, ajustez, « Mémoriser » en Trainer.
6. **Appliquer** : alternez « Appliquer Roue » / « Appliquer Trainer » et vérifiez les résumés.

## Sécurité

- Seuls les noms BLE `EDS TX` avec des données au format TX sont acceptés en écriture.
- Écriture refusée si le nombre de vitesses du profil ≠ celui du dérailleur, si les valeurs ne sont pas strictement croissantes, ou si une valeur s'écarte de plus de *N* pas de la valeur actuelle (150 par défaut, réglable).
- Avant toute écriture : confirmation avec la liste des changements, sauvegarde automatique dans l'appli (téléchargeable en JSON).
- Après écriture : relecture complète et comparaison vitesse par vitesse.
- Déconnexion pendant une écriture : l'opération reste « en attente ». À la reconnexion (automatique, 3 essais), l'appli **relit** le dérailleur et propose *Reprendre*, *Restaurer la sauvegarde* ou *Ignorer*. Elle ne relance jamais une écriture toute seule.
  Limite : le protocole n'a pas d'écriture groupée. Une coupure peut laisser certaines vitesses écrites et d'autres non, d'où la reprise ou restauration.
- **Non implémentés volontairement** : calibration initiale, micro-réglage de calibration, changement du nombre de vitesses, extinction, mise à jour du firmware, écriture des limites du dérailleur avant (lues et stockées dans les profils, jamais écrites).

## Choix faits sur les points non documentés

| Point | Choix (comme drEDS) | Source |
|---|---|---|
| CRC | CRC-16/MODBUS sur toute la trame hors CRC, poids fort en premier (la doc dit « du payload ») | functions.js:1220, 1237 ; vérifié sur les 3 trames réelles de la doc |
| Réponse à `setGearUpValue` | `payload[0] == 0` = accepté | functions.js:371 |
| Sens `rearLifting` | `0x02` = monter (pignon plus petit), `0x01` = descendre. HARDWARE.md:8 dit l'inverse | functions.js:1509, 1519 |
| Numérotation | `H_GEA[1]` = plus petit pignon ; vitesse affichée = total − indice + 1 | functions.js:791, 843 ; style.css:790 |
| Blocs de lecture | Les blocs ASCII se distinguent des trames par l'absence de CRC valide | functions.js:652-666 |
| Limites FD absentes (bug TX) | **Plus redemandées** (v0.3.0) : la commande `0x61` + `01 01 06` de drEDS a un sens non documenté, retirée par prudence. Les limites FD ne s'affichent que si le dérailleur les donne dans ses données | PROTOCOL-APP.md:104 ; functions.js:801 |
| Batteries (% affiché) | Estimation linéaire 6,9 V → 8,2 V, indicative | — |

## Architecture

```
js/protocol.js      UUID, commandes, trames, CRC, analyse des données (pur, sans navigateur)
js/eds-session.js   session : clé, file de requêtes, délais, déconnexions (transport injecté)
js/tuning.js        validation, sauvegarde, écriture, relecture, comparaison
js/storage.js       localStorage + conversion export/import drEDS
js/web-bluetooth.js transport Web Bluetooth
js/simulator.js     dérailleur simulé (tests + mode démo)
js/app.js           interface
tests/              node --test
```

`protocol.js`, `eds-session.js` et `tuning.js` ne dépendent pas de l'interface : ce sont eux à porter en Kotlin pour une future appli Android native.

### Tests

```
npm test
```

- `tests/protocol.test.js` : CRC et encodage/décodage. Les seules données réelles disponibles sont les 3 trames et les dumps texte (TX, OX, GeX) de PROTOCOL-APP.md.
- `tests/tuning.test.js` : session et logique de réglage sur le **simulateur** (refus, écart, perte de réponse, déconnexion en pleine écriture, reprise, restauration, export/import). Le simulateur suit la documentation ; il ne remplace pas un essai réel.

## Origine et licence

Le protocole a été établi par drJeckyll (projet drEDS, https://git.jeckyll.net/published/personal/eds-ox).
Ce dépôt n'a **pas de licence**. Aucun code n'en a donc été repris : tout a été réécrit à partir des faits documentés.

Utilisation à vos risques : un mauvais réglage peut faire sauter la chaîne. Faites vos essais vélo sur pied.
