// Lancer une pub › a group of Landing pages › Groupes (20 Nov 2026): the ad opens the group's page and the customer
// picks the product there. adsets.group_id: the group an ad set sells. Its product_ids are the group's products, so
// « Plus de stock » pauses it only when none of them is left. « Mes pubs » shows it as one card for the group: its spend
// is not shared out between the products, and its orders are the ones that came through the group's page (utm « g »).
export default `
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS group_id bigint;
`;
