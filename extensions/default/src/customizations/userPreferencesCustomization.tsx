import React, { useState } from 'react';
import { useSystem, hotkeys as hotkeysModule } from '@ohif/core';
import {
  UserPreferencesModal,
  FooterAction,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Input,
} from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import i18n from '@ohif/i18n';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@ohif/ui-next';
import {
  getDefaultRoiPreviewSettings,
  getRoiPreviewSettings,
  setRoiPreviewSettings,
} from '../../../ovi-labs/src/utils/roiPreviewSettingsStore';

const { availableLanguages, defaultLanguage, currentLanguage: currentLanguageFn } = i18n;

interface HotkeyDefinition {
  keys: string;
  label: string;
}

interface HotkeyDefinitions {
  [key: string]: HotkeyDefinition;
}

function UserPreferencesModalDefault({ hide }: { hide: () => void }) {
  const { hotkeysManager } = useSystem();
  const { t } = useTranslation('UserPreferencesModal');

  const { hotkeyDefinitions = {}, hotkeyDefaults = {} } = hotkeysManager;

  const currentLanguage = currentLanguageFn();
  const roiPreviewSettings = getRoiPreviewSettings();

  const [state, setState] = useState({
    hotkeyDefinitions: hotkeyDefinitions as HotkeyDefinitions,
    languageValue: currentLanguage.value,
    roiPreviewDelayMs: roiPreviewSettings.accuratePreviewDelayMs,
    roiPreviewInterpolation: roiPreviewSettings.accurateInterpolation,
  });

  const onLanguageChangeHandler = (value: string) => {
    setState(state => ({ ...state, languageValue: value }));
  };

  const onHotkeyChangeHandler = (id: string, newKeys: string) => {
    setState(state => ({
      ...state,
      hotkeyDefinitions: {
        ...state.hotkeyDefinitions,
        [id]: {
          ...state.hotkeyDefinitions[id],
          keys: newKeys,
        },
      },
    }));
  };

  const onRoiPreviewDelayChange = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    const delay = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    setState(state => ({ ...state, roiPreviewDelayMs: delay }));
  };

  const onRoiPreviewInterpolationChange = (value: string) => {
    setState(state => ({
      ...state,
      roiPreviewInterpolation:
        value === 'nearest' || value === 'trilinear' ? value : 'bilinear',
    }));
  };

  const onResetHandler = () => {
    const defaults = getDefaultRoiPreviewSettings();
    setState(state => ({
      ...state,
      languageValue: defaultLanguage.value,
      hotkeyDefinitions: hotkeyDefaults as HotkeyDefinitions,
      roiPreviewDelayMs: defaults.accuratePreviewDelayMs,
      roiPreviewInterpolation: defaults.accurateInterpolation,
    }));

    hotkeysManager.restoreDefaultBindings();
    setRoiPreviewSettings(defaults);
  };

  return (
    <UserPreferencesModal>
      <UserPreferencesModal.Body>
        <Tabs
          defaultValue="viewer"
          className="w-full"
        >
          <TabsList className="mb-4">
            <TabsTrigger value="viewer">Viewer</TabsTrigger>
            <TabsTrigger value="ovi-labs">Ovi Labs</TabsTrigger>
          </TabsList>
          <TabsContent value="viewer">
            <div className="mb-3 flex items-center space-x-14">
              <UserPreferencesModal.SubHeading>{t('Language')}</UserPreferencesModal.SubHeading>
              <Select
                defaultValue={state.languageValue}
                onValueChange={onLanguageChangeHandler}
              >
                <SelectTrigger
                  className="w-60"
                  aria-label="Language"
                >
                  <SelectValue placeholder={t('Select language')} />
                </SelectTrigger>
                <SelectContent>
                  {availableLanguages.map(lang => (
                    <SelectItem
                      key={lang.value}
                      value={lang.value}
                    >
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <UserPreferencesModal.SubHeading>{t('Hotkeys')}</UserPreferencesModal.SubHeading>
            <UserPreferencesModal.HotkeysGrid>
              {Object.entries(state.hotkeyDefinitions).map(([id, definition]) => (
                <UserPreferencesModal.Hotkey
                  key={id}
                  label={t(definition.label)}
                  value={definition.keys}
                  onChange={newKeys => onHotkeyChangeHandler(id, newKeys)}
                  placeholder={definition.keys}
                  hotkeys={hotkeysModule}
                />
              ))}
            </UserPreferencesModal.HotkeysGrid>
          </TabsContent>
          <TabsContent value="ovi-labs">
            <div className="mb-4 flex items-center justify-between gap-6">
              <UserPreferencesModal.SubHeading>Accurate preview delay (ms)</UserPreferencesModal.SubHeading>
              <Input
                className="w-32 text-right"
                type="number"
                min={0}
                value={state.roiPreviewDelayMs}
                onChange={evt => onRoiPreviewDelayChange(evt.target.value)}
              />
            </div>
            <div className="mb-2 flex items-center justify-between gap-6">
              <UserPreferencesModal.SubHeading>Accurate interpolation</UserPreferencesModal.SubHeading>
              <Select
                value={state.roiPreviewInterpolation}
                onValueChange={onRoiPreviewInterpolationChange}
              >
                <SelectTrigger
                  className="w-40"
                  aria-label="Accurate interpolation"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilinear">Bilinear</SelectItem>
                  <SelectItem value="nearest">Nearest</SelectItem>
                  <SelectItem value="trilinear">Trilinear</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </TabsContent>
        </Tabs>
      </UserPreferencesModal.Body>
      <FooterAction>
        <FooterAction.Left>
          <FooterAction.Auxiliary onClick={onResetHandler}>
            {t('Reset to defaults')}
          </FooterAction.Auxiliary>
        </FooterAction.Left>
        <FooterAction.Right>
          <FooterAction.Secondary
            onClick={() => {
              hotkeysModule.stopRecord();
              hotkeysModule.unpause();
              hide();
            }}
          >
            {t('Cancel')}
          </FooterAction.Secondary>
          <FooterAction.Primary
            onClick={() => {
              if (state.languageValue !== currentLanguage.value) {
                i18n.changeLanguage(state.languageValue);
              }
              hotkeysManager.setHotkeys(state.hotkeyDefinitions);
              setRoiPreviewSettings({
                accuratePreviewDelayMs: state.roiPreviewDelayMs,
                accurateInterpolation: state.roiPreviewInterpolation,
              });
              hotkeysModule.stopRecord();
              hotkeysModule.unpause();
              hide();
            }}
          >
            {t('Save')}
          </FooterAction.Primary>
        </FooterAction.Right>
      </FooterAction>
    </UserPreferencesModal>
  );
}

export default {
  'ohif.userPreferencesModal': UserPreferencesModalDefault,
};
