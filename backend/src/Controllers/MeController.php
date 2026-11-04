<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

/** Signed-in customer: profile, saved addresses, own bookings. Ownership = user_id only. */
final class MeController
{
    public function __construct(private App $app)
    {
    }

    public static function profileToApi(array $u, ?array $p): array
    {
        return [
            'name' => $u['name'],
            'email' => $u['email'],
            'emailVerified' => $u['email_verified_at'] !== null,
            'phone' => $u['phone'],
            'preferredContactMethod' => $p['preferred_contact_method'] ?? null,
            'preferences' => [
                'fragrancePreference' => $p['fragrance_preference'] ?? null,
                'focusPreference' => $p['focus_preference'] ?? null,
                'petPreference' => $p['pet_preference'] ?? null,
                'notes' => $p['preferences_notes'] ?? null,
            ],
            'memberSince' => \SanchezServices\Domain\BookingRepo::iso($u['created_at']),
        ];
    }

    public function profile(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $row = (array) $this->app->users->rowById($u->id);
        $p = $this->app->db->one('SELECT * FROM client_profiles WHERE user_id = ?', [$u->id]);
        return Response::json(['profile' => self::profileToApi($row, $p)]);
    }

    public function updateProfile(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $in = Input::from($r);
        $name = $in->has('name') ? $in->str('name', true, 200) : $u->name;
        $phone = $in->has('phone') ? $in->phone('phone') : $u->phone;
        $this->app->db->transaction(function () use ($u, $in, $name, $phone) {
            $this->app->auth->updateContact($name, $phone);
            $now = Clock::toSql($this->app->clock->now());
            $this->app->db->run('INSERT IGNORE INTO client_profiles (user_id, created_at, updated_at) VALUES (?, ?, ?)', [$u->id, $now, $now]);
            $set = ['phone_normalized' => $phone, 'updated_at' => $now];
            if ($in->has('preferredContactMethod')) {
                $set['preferred_contact_method'] = $in->enum('preferredContactMethod', ['email', 'phone', 'text']);
            }
            if ($prefs = $in->sub('preferences')) {
                foreach (['fragrancePreference' => 'fragrance_preference', 'focusPreference' => 'focus_preference', 'petPreference' => 'pet_preference'] as $k => $col) {
                    if ($prefs->has($k)) {
                        $set[$col] = $prefs->str($k, false, 40);
                    }
                }
                if ($prefs->has('notes')) {
                    $set['preferences_notes'] = $prefs->str('notes', false, 2000);
                }
            }
            $this->app->db->update('client_profiles', $set, ['user_id' => $u->id]);
        });
        return $this->profile($r);
    }

    // ------------------------------------------------------------------ addresses

    public static function addressToApi(array $a): array
    {
        return [
            'id' => (int) $a['id'], 'label' => $a['label'], 'line1' => $a['line1'], 'line2' => $a['line2'], 'city' => $a['city'],
            'state' => $a['state'], 'zip' => $a['zip'], 'accessInstructions' => $a['access_instructions'],
            'isDefault' => (int) $a['is_default'] === 1, 'sortOrder' => (int) $a['sort_order'],
        ];
    }

    public function addresses(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $rows = $this->app->db->all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, sort_order, id', [$u->id]);
        return Response::json(['addresses' => array_map([self::class, 'addressToApi'], $rows)]);
    }

    private function addressFields(Input $in, bool $partial): array
    {
        $out = [];
        foreach (['label' => 60, 'line1' => 200, 'line2' => 200, 'city' => 100, 'accessInstructions' => 2000] as $k => $max) {
            if (!$partial || $in->has($k)) {
                $out[$k === 'accessInstructions' ? 'access_instructions' : $k] = $in->str($k, !$partial && in_array($k, ['line1', 'city'], true), $max);
            }
        }
        if (!$partial || $in->has('state')) {
            $s = strtoupper((string) $in->str('state', true, 2));
            if (!preg_match('/^[A-Z]{2}$/', $s)) {
                throw new HttpError('invalid-argument', 'Choose a state.', ['field' => 'state']);
            }
            $out['state'] = $s;
        }
        if (!$partial || $in->has('zip')) {
            $z = (string) $in->str('zip', true, 10);
            if (!preg_match('/^\d{5}(-\d{4})?$/', $z)) {
                throw new HttpError('invalid-argument', 'Enter a valid ZIP code.', ['field' => 'zip']);
            }
            $out['zip'] = $z;
        }
        if ($in->has('sortOrder')) {
            $out['sort_order'] = $in->int('sortOrder', false, 0, 1000);
        }
        return $out;
    }

    public function addAddress(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $in = Input::from($r);
        $f = $this->addressFields($in, false);
        $this->app->db->transaction(function () use ($u, $in, $f) {
            if ((int) $this->app->db->scalar('SELECT COUNT(*) FROM addresses WHERE user_id = ?', [$u->id]) >= 20) {
                throw new HttpError('resource-exhausted', 'You can save up to 20 addresses.');
            }
            $first = (int) $this->app->db->scalar('SELECT COUNT(*) FROM addresses WHERE user_id = ?', [$u->id]) === 0;
            $default = $first || $in->bool('isDefault');
            if ($default) {
                $this->app->db->run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [$u->id]);
            }
            $now = Clock::toSql($this->app->clock->now());
            $this->app->db->insert('addresses', $f + ['user_id' => $u->id, 'is_default' => $default ? 1 : 0, 'created_at' => $now, 'updated_at' => $now]);
        });
        return $this->addresses($r);
    }

    private function ownAddress(int $userId, int $id): array
    {
        return $this->app->db->one('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [$id, $userId]) ?? throw HttpError::notFound('Address not found.');
    }

    public function updateAddress(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $a = $this->ownAddress($u->id, (int) $r->param('id'));
        $in = Input::from($r);
        $f = $this->addressFields($in, true);
        $this->app->db->transaction(function () use ($u, $a, $in, $f) {
            if ($in->bool('isDefault')) {
                $this->app->db->run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [$u->id]);
                $f['is_default'] = 1;
            }
            if ($f) {
                $f['updated_at'] = Clock::toSql($this->app->clock->now());
                $this->app->db->update('addresses', $f, ['id' => (int) $a['id']]);
            }
        });
        return $this->addresses($r);
    }

    public function deleteAddress(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $a = $this->ownAddress($u->id, (int) $r->param('id'));
        $this->app->db->transaction(function () use ($u, $a) {
            $this->app->db->run('DELETE FROM addresses WHERE id = ?', [(int) $a['id']]);
            if ((int) $a['is_default'] === 1) {
                $this->app->db->run('UPDATE addresses SET is_default = 1 WHERE user_id = ? ORDER BY sort_order, id LIMIT 1', [$u->id]);
            }
        });
        return $this->addresses($r);
    }

    // ------------------------------------------------------------------ bookings

    public function bookings(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $rows = $this->app->db->all('SELECT * FROM bookings WHERE user_id = ? ORDER BY start_at DESC LIMIT 500', [$u->id]);
        return Response::json(['bookings' => array_map(fn ($b) => $this->app->repo->toApi($b), $rows)]);
    }
}
